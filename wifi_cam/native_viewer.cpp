#define SDL_MAIN_HANDLED

#include <SDL.h>
#include <jpeglib.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <mutex>
#include <optional>
#include <setjmp.h>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr const char* kDefaultHost = "192.168.4.1";
constexpr int kControlPort = 80;
constexpr int kStreamPort = 81;
constexpr std::size_t kMaxFrameSize = 16 * 1024 * 1024;
constexpr std::uint8_t kJpegStart[] = {0xff, 0xd8};
constexpr std::uint8_t kJpegEnd[] = {0xff, 0xd9};

void log(const std::string& message) {
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm tm{};
  localtime_r(&now, &tm);
  std::cout << '[' << std::put_time(&tm, "%H:%M:%S") << "] " << message << std::endl;
}

struct Resolution {
  int frameSize;
  int width;
  int height;
};

constexpr Resolution kResolutions[] = {
    {5, 320, 240}, {8, 640, 480}, {9, 800, 600}, {10, 1024, 768}, {11, 1280, 720}};

struct Config {
  std::string host = kDefaultHost;
  int controlPort = kControlPort;
  int streamPort = kStreamPort;
  int frameSize = 11;
  int jpegQuality = 20;
  bool vsync = true;
  std::size_t bufferFrames = 1;
  double displayFps = 0.0;
};

const Resolution* resolutionFor(int frameSize) {
  for (const auto& resolution : kResolutions) {
    if (resolution.frameSize == frameSize) return &resolution;
  }
  return nullptr;
}

Config parseArgs(int argc, char** argv) {
  Config config;
  for (int i = 1; i < argc; ++i) {
    const std::string key = argv[i];
    auto value = [&]() -> std::string {
      if (++i >= argc) {
        std::cerr << "Missing value after " << key << '\n';
        std::exit(2);
      }
      return argv[i];
    };

    if (key == "--host") config.host = value();
    else if (key == "--control-port") config.controlPort = std::stoi(value());
    else if (key == "--stream-port") config.streamPort = std::stoi(value());
    else if (key == "--frame-size") config.frameSize = std::stoi(value());
    else if (key == "--quality") config.jpegQuality = std::stoi(value());
    else if (key == "--buffer-frames") config.bufferFrames = std::stoul(value());
    else if (key == "--display-fps") config.displayFps = std::stod(value());
    else if (key == "--smooth") {
      config.bufferFrames = 3;
      config.displayFps = 15.0;
    } else if (key == "--no-vsync") {
      config.vsync = false;
    } else if (key == "--help" || key == "-h") {
      std::cout << "Usage: wifi_backup_viewer [--host 192.168.4.1] "
                   "[--frame-size 11] [--quality 20] [--no-vsync] [--smooth] "
                   "[--buffer-frames 1] [--display-fps 0]\n\n"
                   "  --frame-size      11=1280x720, 10=1024x768, 9=800x600, "
                   "8=640x480, 5=320x240\n"
                   "  --quality         ESP32 JPEG compression 4-63; higher is smaller/faster\n"
                   "  --smooth          Three-frame buffer paced at 15 fps\n"
                   "  --buffer-frames   Completed-frame queue depth (default 1)\n"
                   "  --display-fps     Presentation cadence; 0 shows immediately\n";
      std::exit(0);
    } else {
      std::cerr << "Unknown option: " << key << '\n';
      std::exit(2);
    }
  }

  if (!resolutionFor(config.frameSize)) {
    std::cerr << "--frame-size must be one of 5, 8, 9, 10, or 11\n";
    std::exit(2);
  }
  if (config.jpegQuality < 4 || config.jpegQuality > 63) {
    std::cerr << "--quality must be between 4 and 63\n";
    std::exit(2);
  }
  if (config.bufferFrames < 1 || config.bufferFrames > 60) {
    std::cerr << "--buffer-frames must be between 1 and 60\n";
    std::exit(2);
  }
  if (config.displayFps < 0.0 || config.displayFps > 120.0) {
    std::cerr << "--display-fps must be between 0 and 120\n";
    std::exit(2);
  }
  return config;
}

int connectTcp(const std::string& host, int port) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;

  timeval timeout{5, 0};
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));

  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(static_cast<std::uint16_t>(port));
  if (::inet_pton(AF_INET, host.c_str(), &address.sin_addr) != 1 ||
      ::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
    ::close(fd);
    return -1;
  }
  return fd;
}

bool sendAll(int fd, const std::string& data) {
  std::size_t sent = 0;
  while (sent < data.size()) {
    const auto count = ::send(fd, data.data() + sent, data.size() - sent, 0);
    if (count <= 0) return false;
    sent += static_cast<std::size_t>(count);
  }
  return true;
}

bool readHttpHeaders(int fd, std::vector<std::uint8_t>& remainder) {
  std::vector<std::uint8_t> bytes;
  std::uint8_t chunk[4096];
  constexpr char separator[] = "\r\n\r\n";

  while (bytes.size() < 64 * 1024) {
    const auto count = ::recv(fd, chunk, sizeof(chunk), 0);
    if (count <= 0) return false;
    bytes.insert(bytes.end(), chunk, chunk + count);
    const auto headerEnd = std::search(
        bytes.begin(), bytes.end(), std::begin(separator), std::end(separator) - 1);
    if (headerEnd == bytes.end()) continue;

    const std::string headers(bytes.begin(), headerEnd);
    if (headers.find(" 200 ") == std::string::npos) {
      log("HTTP request failed: " + headers.substr(0, headers.find("\r\n")));
      return false;
    }
    remainder.assign(headerEnd + 4, bytes.end());
    return true;
  }
  return false;
}

bool applyControl(const Config& config, const std::string& variable, int value) {
  const int fd = connectTcp(config.host, config.controlPort);
  if (fd < 0) {
    log("Could not connect to XIAO control endpoint");
    return false;
  }

  std::ostringstream request;
  request << "GET /control?var=" << variable << "&val=" << value
          << " HTTP/1.1\r\nHost: " << config.host
          << "\r\nConnection: close\r\n\r\n";
  std::vector<std::uint8_t> remainder;
  const bool ok = sendAll(fd, request.str()) && readHttpHeaders(fd, remainder);
  ::close(fd);
  if (ok) log("Camera control: " + variable + '=' + std::to_string(value));
  return ok;
}

struct Metrics {
  std::atomic<std::uint64_t> reads{0};
  std::atomic<std::uint64_t> frames{0};
  std::atomic<std::uint64_t> displayed{0};
  std::atomic<std::uint64_t> replaced{0};
  std::atomic<std::uint64_t> decodeFailures{0};
};

class FrameQueue {
 public:
  explicit FrameQueue(std::size_t capacity) : capacity_(capacity) {}

  void put(std::vector<std::uint8_t>&& jpeg, Metrics& metrics) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (frames_.size() >= capacity_) {
      frames_.pop_front();
      ++metrics.replaced;
    }
    frames_.push_back(std::move(jpeg));
  }

  std::optional<std::vector<std::uint8_t>> take() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (frames_.empty()) return std::nullopt;
    auto result = std::move(frames_.front());
    frames_.pop_front();
    return result;
  }

  std::size_t size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return frames_.size();
  }

 private:
  const std::size_t capacity_;
  mutable std::mutex mutex_;
  std::deque<std::vector<std::uint8_t>> frames_;
};

class HttpMjpegReceiver {
 public:
  HttpMjpegReceiver(const Config& config, FrameQueue& frames, Metrics& metrics)
      : config_(config), frames_(frames), metrics_(metrics) {}
  ~HttpMjpegReceiver() { stop(); }

  bool start() {
    fd_ = connectTcp(config_.host, config_.streamPort);
    if (fd_ < 0) {
      log("Could not connect to XIAO MJPEG stream");
      return false;
    }

    std::ostringstream request;
    request << "GET /stream HTTP/1.1\r\nHost: " << config_.host
            << "\r\nAccept: multipart/x-mixed-replace\r\nConnection: close\r\n\r\n";
    if (!sendAll(fd_, request.str()) || !readHttpHeaders(fd_, buffer_)) {
      ::close(fd_);
      fd_ = -1;
      return false;
    }

    timeval timeout{1, 0};
    ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    running_ = true;
    thread_ = std::thread(&HttpMjpegReceiver::loop, this);
    log("Streaming http://" + config_.host + ':' + std::to_string(config_.streamPort) +
        "/stream");
    return true;
  }

  void stop() {
    running_ = false;
    if (fd_ >= 0) ::shutdown(fd_, SHUT_RDWR);
    if (thread_.joinable()) thread_.join();
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
  }

 private:
  void extractFrames() {
    while (!buffer_.empty()) {
      const auto start = std::search(
          buffer_.begin(), buffer_.end(), std::begin(kJpegStart), std::end(kJpegStart));
      if (start == buffer_.end()) {
        const bool keepLast = buffer_.back() == 0xff;
        buffer_.clear();
        if (keepLast) buffer_.push_back(0xff);
        return;
      }
      if (start != buffer_.begin()) buffer_.erase(buffer_.begin(), start);

      const auto end = std::search(
          buffer_.begin() + 2, buffer_.end(), std::begin(kJpegEnd), std::end(kJpegEnd));
      if (end == buffer_.end()) {
        if (buffer_.size() > kMaxFrameSize) {
          log("JPEG exceeded maximum frame size; resetting parser");
          buffer_.clear();
        }
        return;
      }

      const auto frameEnd = end + 2;
      std::vector<std::uint8_t> frame(buffer_.begin(), frameEnd);
      buffer_.erase(buffer_.begin(), frameEnd);
      ++metrics_.frames;
      frames_.put(std::move(frame), metrics_);
    }
  }

  void loop() {
    std::uint8_t chunk[64 * 1024];
    extractFrames();
    while (running_) {
      const auto count = ::recv(fd_, chunk, sizeof(chunk), 0);
      if (count > 0) {
        ++metrics_.reads;
        buffer_.insert(buffer_.end(), chunk, chunk + count);
        extractFrames();
      } else if (count == 0) {
        if (running_) log("XIAO stream connection closed");
        break;
      } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
        if (running_) log(std::string("XIAO stream read failed: ") + std::strerror(errno));
        break;
      }
    }
    running_ = false;
  }

  const Config& config_;
  FrameQueue& frames_;
  Metrics& metrics_;
  int fd_ = -1;
  std::atomic<bool> running_{false};
  std::thread thread_;
  std::vector<std::uint8_t> buffer_;
};

struct JpegError {
  jpeg_error_mgr base;
  jmp_buf jump;
};

void jpegErrorExit(j_common_ptr info) {
  auto* error = reinterpret_cast<JpegError*>(info->err);
  longjmp(error->jump, 1);
}

bool decodeJpeg(const std::vector<std::uint8_t>& jpeg,
                std::vector<std::uint8_t>& rgb, int& width, int& height) {
  jpeg_decompress_struct decoder{};
  JpegError error{};
  decoder.err = jpeg_std_error(&error.base);
  error.base.error_exit = jpegErrorExit;
  if (setjmp(error.jump)) {
    jpeg_destroy_decompress(&decoder);
    return false;
  }
  jpeg_create_decompress(&decoder);
  jpeg_mem_src(&decoder, jpeg.data(), static_cast<unsigned long>(jpeg.size()));
  jpeg_read_header(&decoder, TRUE);
  decoder.out_color_space = JCS_RGB;
  decoder.dct_method = JDCT_IFAST;
  jpeg_start_decompress(&decoder);
  width = static_cast<int>(decoder.output_width);
  height = static_cast<int>(decoder.output_height);
  rgb.resize(static_cast<std::size_t>(width) * height * 3);
  while (decoder.output_scanline < decoder.output_height) {
    auto* row = rgb.data() + static_cast<std::size_t>(decoder.output_scanline) * width * 3;
    jpeg_read_scanlines(&decoder, &row, 1);
  }
  jpeg_finish_decompress(&decoder);
  jpeg_destroy_decompress(&decoder);
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  std::signal(SIGPIPE, SIG_IGN);
  const Config config = parseArgs(argc, argv);
  const Resolution* requestedResolution = resolutionFor(config.frameSize);

  if (!applyControl(config, "framesize", config.frameSize) ||
      !applyControl(config, "quality", config.jpegQuality)) {
    return 1;
  }

  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0) {
    std::cerr << "SDL_Init failed: " << SDL_GetError() << '\n';
    return 1;
  }
  SDL_Window* window = SDL_CreateWindow(
      "XIAO Wi-Fi Backup Camera", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
      960, 540, SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
  if (!window) {
    std::cerr << "SDL window failed: " << SDL_GetError() << '\n';
    SDL_Quit();
    return 1;
  }
  const auto rendererFlags = static_cast<Uint32>(
      SDL_RENDERER_ACCELERATED | (config.vsync ? SDL_RENDERER_PRESENTVSYNC : 0));
  SDL_Renderer* renderer = SDL_CreateRenderer(window, -1, rendererFlags);
  if (!renderer) renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!renderer) {
    std::cerr << "SDL renderer failed: " << SDL_GetError() << '\n';
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 1;
  }

  FrameQueue latest(config.bufferFrames);
  Metrics metrics;
  HttpMjpegReceiver receiver(config, latest, metrics);
  if (!receiver.start()) {
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 1;
  }

  SDL_Texture* texture = nullptr;
  int textureWidth = 0;
  int textureHeight = 0;
  std::vector<std::uint8_t> rgb;
  bool running = true;
  const auto started = std::chrono::steady_clock::now();
  const auto presentationInterval = config.displayFps > 0.0
      ? std::chrono::microseconds(static_cast<std::int64_t>(1000000.0 / config.displayFps))
      : std::chrono::microseconds(0);
  auto nextPresentation = started;
  bool presentationPrimed = config.bufferFrames == 1;
  auto lastTitleUpdate = started;

  while (running) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
      if (event.type == SDL_QUIT) running = false;
      if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_ESCAPE) running = false;
    }

    const auto now = std::chrono::steady_clock::now();
    if (!presentationPrimed && latest.size() >= config.bufferFrames) {
      presentationPrimed = true;
      nextPresentation = now;
    }
    const bool presentationDue = presentationPrimed &&
        (config.displayFps == 0.0 || now >= nextPresentation);
    std::optional<std::vector<std::uint8_t>> frame;
    if (presentationDue) {
      frame = latest.take();
      if (config.displayFps > 0.0) nextPresentation = now + presentationInterval;
    }

    if (frame) {
      int width = 0;
      int height = 0;
      if (decodeJpeg(*frame, rgb, width, height)) {
        if (!texture || width != textureWidth || height != textureHeight) {
          if (texture) SDL_DestroyTexture(texture);
          texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGB24,
                                      SDL_TEXTUREACCESS_STREAMING, width, height);
          textureWidth = width;
          textureHeight = height;
          log("Decoded stream resolution=" + std::to_string(width) + 'x' +
              std::to_string(height));
          if (requestedResolution &&
              (width != requestedResolution->width || height != requestedResolution->height)) {
            log("WARNING camera ignored requested resolution");
          }
        }
        SDL_UpdateTexture(texture, nullptr, rgb.data(), width * 3);
        SDL_RenderClear(renderer);
        int outputWidth = 0;
        int outputHeight = 0;
        SDL_GetRendererOutputSize(renderer, &outputWidth, &outputHeight);
        const double scale = std::min(
            static_cast<double>(outputWidth) / width,
            static_cast<double>(outputHeight) / height);
        SDL_Rect destination{
            (outputWidth - static_cast<int>(width * scale)) / 2,
            (outputHeight - static_cast<int>(height * scale)) / 2,
            static_cast<int>(width * scale), static_cast<int>(height * scale)};
        SDL_RenderCopy(renderer, texture, nullptr, &destination);
        SDL_RenderPresent(renderer);
        ++metrics.displayed;
      } else {
        ++metrics.decodeFailures;
      }
    } else {
      SDL_Delay(1);
    }

    if (now - lastTitleUpdate >= std::chrono::milliseconds(500)) {
      const double seconds = std::chrono::duration<double>(now - started).count();
      const double fps = seconds > 0 ? metrics.frames.load() / seconds : 0;
      std::ostringstream title;
      title << "XIAO Backup Camera — " << std::fixed << std::setprecision(1) << fps
            << " fps — queue " << latest.size() << '/' << config.bufferFrames
            << " — replaced " << metrics.replaced.load()
            << " — decode failures " << metrics.decodeFailures.load();
      SDL_SetWindowTitle(window, title.str().c_str());
      lastTitleUpdate = now;
    }
  }

  receiver.stop();
  if (texture) SDL_DestroyTexture(texture);
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return 0;
}
