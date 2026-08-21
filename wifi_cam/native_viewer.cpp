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
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <setjmp.h>

namespace {

constexpr const char* kDefaultHost = "192.168.1.1";
constexpr int kControlPort = 3333;
constexpr int kUdpPort = 2224;
constexpr int kTcpVideoPort = 2229;
constexpr std::size_t kFrameHeaderSize = 20;
constexpr std::uint8_t kJpegFrame = 2;
constexpr std::size_t kMaxFrameSize = 16 * 1024 * 1024;

void log(const std::string& message) {
  const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm tm{};
  localtime_r(&now, &tm);
  std::cout << '[' << std::put_time(&tm, "%H:%M:%S") << "] " << message << std::endl;
}

std::uint16_t u16le(const std::uint8_t* p) {
  return static_cast<std::uint16_t>(p[0]) |
         (static_cast<std::uint16_t>(p[1]) << 8);
}

std::uint32_t u32le(const std::uint8_t* p) {
  return static_cast<std::uint32_t>(p[0]) |
         (static_cast<std::uint32_t>(p[1]) << 8) |
         (static_cast<std::uint32_t>(p[2]) << 16) |
         (static_cast<std::uint32_t>(p[3]) << 24);
}

void appendLE(std::vector<std::uint8_t>& out, std::uint16_t value) {
  out.push_back(static_cast<std::uint8_t>(value & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xff));
}

void appendLE(std::vector<std::uint8_t>& out, std::uint32_t value) {
  out.push_back(static_cast<std::uint8_t>(value & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 8) & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 16) & 0xff));
  out.push_back(static_cast<std::uint8_t>((value >> 24) & 0xff));
}

struct Config {
  std::string host = kDefaultHost;
  int controlPort = kControlPort;
  int udpPort = kUdpPort;
  int tcpVideoPort = kTcpVideoPort;
  int width = 640;
  int height = 480;
  int fps = 25;
  bool vsync = true;
  std::string transport = "udp";
  std::size_t bufferFrames = 1;
  double displayFps = 0.0;
};

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
    else if (key == "--udp-port") config.udpPort = std::stoi(value());
    else if (key == "--tcp-port") config.tcpVideoPort = std::stoi(value());
    else if (key == "--transport") {
      config.transport = value();
      if (config.transport != "udp" && config.transport != "tcp") {
        std::cerr << "--transport must be udp or tcp\n";
        std::exit(2);
      }
    }
    else if (key == "--width") config.width = std::stoi(value());
    else if (key == "--height") config.height = std::stoi(value());
    else if (key == "--fps") config.fps = std::stoi(value());
    else if (key == "--buffer-frames") config.bufferFrames = std::stoul(value());
    else if (key == "--display-fps") config.displayFps = std::stod(value());
    else if (key == "--smooth") {
      config.bufferFrames = 3;
      config.displayFps = 15.0;
    }
    else if (key == "--no-vsync") config.vsync = false;
    else if (key == "--help" || key == "-h") {
      std::cout << "Usage: wifi_backup_viewer [--host 192.168.1.1] "
                   "[--transport udp|tcp] [--width 640] [--height 480] "
                   "[--fps 25] [--no-vsync] [--smooth] "
                   "[--buffer-frames 1] [--display-fps 0]\n\n"
                   "  --smooth          Three-frame buffer paced at 15 fps\n"
                   "  --buffer-frames   Completed-frame queue depth (default 1)\n"
                   "  --display-fps     Presentation cadence; 0 shows immediately\n";
      std::exit(0);
    } else {
      std::cerr << "Unknown option: " << key << '\n';
      std::exit(2);
    }
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

std::vector<std::uint8_t> ctpPacket(const std::string& topic,
                                    const std::string& json) {
  std::vector<std::uint8_t> packet;
  packet.insert(packet.end(), {'C', 'T', 'P', ':'});
  appendLE(packet, static_cast<std::uint16_t>(topic.size()));
  packet.insert(packet.end(), topic.begin(), topic.end());
  appendLE(packet, static_cast<std::uint32_t>(json.size()));
  packet.insert(packet.end(), json.begin(), json.end());
  return packet;
}

bool readExact(int fd, void* destination, std::size_t size) {
  auto* out = static_cast<std::uint8_t*>(destination);
  std::size_t received = 0;
  while (received < size) {
    const auto count = ::recv(fd, out + received, size - received, 0);
    if (count <= 0) return false;
    received += static_cast<std::size_t>(count);
  }
  return true;
}

bool sendAll(int fd, const std::vector<std::uint8_t>& bytes) {
  std::size_t sent = 0;
  while (sent < bytes.size()) {
    const auto count = ::send(fd, bytes.data() + sent, bytes.size() - sent, 0);
    if (count <= 0) return false;
    sent += static_cast<std::size_t>(count);
  }
  return true;
}

class ControlChannel {
 public:
  explicit ControlChannel(const Config& config) : config_(config) {}
  ~ControlChannel() { stop(); }

  bool start() {
    fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0) return fail("control socket");
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<std::uint16_t>(config_.controlPort));
    if (::inet_pton(AF_INET, config_.host.c_str(), &address.sin_addr) != 1) {
      log("Invalid camera IP: " + config_.host);
      return false;
    }
    if (::connect(fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      return fail("control connect");
    }
    running_ = true;
    reader_ = std::thread(&ControlChannel::readerLoop, this);
    heartbeat_ = std::thread(&ControlChannel::heartbeatLoop, this);
    log("Control connected to " + config_.host + ':' + std::to_string(config_.controlPort));
    sendTopic("APP_ACCESS", R"({"op":"PUT","param":{"type":"0","ver":"20701"}})");
    {
      std::unique_lock<std::mutex> lock(accessMutex_);
      accessCondition_.wait_for(lock, std::chrono::seconds(1), [&] { return accessed_; });
    }
    waitForStartupQuiet();
    return true;
  }

  void openStream() {
    std::ostringstream json;
    json << R"({"op":"PUT","param":{"format":"0","w":")" << config_.width
         << R"(","h":")" << config_.height << R"(","fps":")" << config_.fps
         << R"("}})";
    sendTopic("OPEN_RT_STREAM", json.str());
  }

  void stop() {
    if (fd_ < 0) return;
    if (running_) {
      sendTopic("CLOSE_RT_STREAM", R"({"op":"PUT","param":{"status":"1"}})");
    }
    running_ = false;
    ::shutdown(fd_, SHUT_RDWR);
    if (reader_.joinable()) reader_.join();
    if (heartbeat_.joinable()) heartbeat_.join();
    ::close(fd_);
    fd_ = -1;
  }

 private:
  bool fail(const char* action) {
    log(std::string(action) + " failed: " + std::strerror(errno));
    return false;
  }

  void sendTopic(const std::string& topic, const std::string& json) {
    const auto packet = ctpPacket(topic, json);
    std::lock_guard<std::mutex> lock(sendMutex_);
    if (!sendAll(fd_, packet)) running_ = false;
    if (topic != "CTP_KEEP_ALIVE") {
      if (topic == "VIDEO_SIZE" || topic == "VIDEO_PARAM" ||
          topic == "OPEN_RT_STREAM") {
        log("CTP -> " + topic + " " + json);
      } else {
        log("CTP -> " + topic);
      }
    }
  }

  void heartbeatLoop() {
    while (running_) {
      for (int i = 0; i < 50 && running_; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
      if (running_) sendTopic("CTP_KEEP_ALIVE", R"({"op":"PUT"})");
    }
  }

  void waitForStartupQuiet() {
    constexpr auto quietPeriod = std::chrono::milliseconds(350);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(2500);
    std::unique_lock<std::mutex> lock(statusMutex_);
    while (running_) {
      const auto now = std::chrono::steady_clock::now();
      if (now - lastStatusMessage_ >= quietPeriod || now >= deadline) break;
      statusCondition_.wait_until(lock, std::min(deadline, lastStatusMessage_ + quietPeriod));
    }
    log("Initial camera status complete; opening requested stream");
  }

  void readerLoop() {
    while (running_) {
      std::uint8_t signature[4];
      if (!readExact(fd_, signature, sizeof(signature))) break;
      if (std::memcmp(signature, "CTP:", 4) != 0) continue;
      std::uint8_t topicLengthBytes[2];
      if (!readExact(fd_, topicLengthBytes, 2)) break;
      const auto topicLength = u16le(topicLengthBytes);
      std::string topic(topicLength, '\0');
      if (!readExact(fd_, topic.data(), topic.size())) break;
      std::uint8_t payloadLengthBytes[4];
      if (!readExact(fd_, payloadLengthBytes, 4)) break;
      const auto payloadLength = u32le(payloadLengthBytes);
      if (payloadLength > 5 * 1024 * 1024) break;
      std::vector<std::uint8_t> payload(payloadLength);
      if (payloadLength && !readExact(fd_, payload.data(), payload.size())) break;
      {
        std::lock_guard<std::mutex> lock(statusMutex_);
        lastStatusMessage_ = std::chrono::steady_clock::now();
        statusCondition_.notify_all();
      }
      if (topic == "APP_ACCESS") {
        std::lock_guard<std::mutex> lock(accessMutex_);
        accessed_ = true;
        accessCondition_.notify_all();
      } else if (topic == "OPEN_RT_STREAM") {
        const std::string response(payload.begin(), payload.end());
        log("Camera OPEN_RT_STREAM reply: " + response);
      } else if (topic == "RTF_RES" || topic == "VIDEO_SIZE" ||
                 topic == "VIDEO_PARAM") {
        const std::string response(payload.begin(), payload.end());
        log("Camera " + topic + " reply: " + response);
      }
    }
    running_ = false;
  }

  const Config& config_;
  int fd_ = -1;
  std::atomic<bool> running_{false};
  std::thread reader_;
  std::thread heartbeat_;
  std::mutex sendMutex_;
  std::mutex accessMutex_;
  std::condition_variable accessCondition_;
  bool accessed_ = false;
  std::mutex statusMutex_;
  std::condition_variable statusCondition_;
  std::chrono::steady_clock::time_point lastStatusMessage_ =
      std::chrono::steady_clock::now();
};

struct Metrics {
  std::atomic<std::uint64_t> packets{0};
  std::atomic<std::uint64_t> frames{0};
  std::atomic<std::uint64_t> displayed{0};
  std::atomic<std::uint64_t> incomplete{0};
  std::atomic<std::uint64_t> replaced{0};
  std::atomic<std::uint64_t> sequenceGaps{0};
  std::atomic<std::uint64_t> decodeFailures{0};
  std::atomic<std::uint64_t> arrivalGapUs{0};
  std::atomic<std::uint64_t> arrivalGapSamples{0};
  std::atomic<std::uint64_t> arrivalGapMaxUs{0};
  std::atomic<std::uint64_t> decodeUs{0};
  std::atomic<std::uint64_t> decodeSamples{0};
  std::atomic<std::uint64_t> decodeMaxUs{0};
};

void atomicMax(std::atomic<std::uint64_t>& target, std::uint64_t value) {
  auto current = target.load(std::memory_order_relaxed);
  while (current < value &&
         !target.compare_exchange_weak(current, value, std::memory_order_relaxed)) {
  }
}

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

struct Assembly {
  std::size_t frameSize = 0;
  std::map<std::size_t, std::vector<std::uint8_t>> chunks;
};

class FrameAssembler {
 public:
  FrameAssembler(FrameQueue& latest, Metrics& metrics)
      : latest_(latest), metrics_(metrics) {}

  void consume(std::uint8_t type, std::uint32_t sequence, std::size_t frameSize,
               std::size_t offset, const std::uint8_t* chunk, std::size_t chunkSize) {
    if (type != kJpegFrame) return;
    auto& assembly = assemblies_[sequence];
    if (assembly.frameSize != frameSize) {
      assembly = Assembly{};
      assembly.frameSize = frameSize;
    }
    assembly.chunks.try_emplace(offset, chunk, chunk + chunkSize);
    complete(sequence, assembly);
    while (assemblies_.size() > 8) {
      assemblies_.erase(assemblies_.begin());
      ++metrics_.incomplete;
    }
  }

 private:
  void complete(std::uint32_t sequence, Assembly& assembly) {
    std::size_t expected = 0;
    for (const auto& [offset, chunk] : assembly.chunks) {
      if (offset != expected) return;
      expected += chunk.size();
    }
    if (expected != assembly.frameSize) return;
    std::vector<std::uint8_t> jpeg;
    jpeg.reserve(assembly.frameSize);
    for (const auto& [_, chunk] : assembly.chunks) {
      jpeg.insert(jpeg.end(), chunk.begin(), chunk.end());
    }
    assemblies_.erase(sequence);
    const auto completedAt = std::chrono::steady_clock::now();
    if (lastCompletedAt_) {
      const auto gap = std::chrono::duration_cast<std::chrono::microseconds>(
                           completedAt - *lastCompletedAt_)
                           .count();
      if (gap >= 0) {
        metrics_.arrivalGapUs.fetch_add(static_cast<std::uint64_t>(gap),
                                        std::memory_order_relaxed);
        metrics_.arrivalGapSamples.fetch_add(1, std::memory_order_relaxed);
        atomicMax(metrics_.arrivalGapMaxUs, static_cast<std::uint64_t>(gap));
      }
    }
    lastCompletedAt_ = completedAt;
    if (lastSequence_ && sequence > *lastSequence_ + 1) {
      metrics_.sequenceGaps.fetch_add(sequence - *lastSequence_ - 1,
                                      std::memory_order_relaxed);
    }
    if (!lastSequence_ || sequence > *lastSequence_) lastSequence_ = sequence;
    ++metrics_.frames;
    latest_.put(std::move(jpeg), metrics_);
  }

  FrameQueue& latest_;
  Metrics& metrics_;
  std::map<std::uint32_t, Assembly> assemblies_;
  std::optional<std::chrono::steady_clock::time_point> lastCompletedAt_;
  std::optional<std::uint32_t> lastSequence_;
};

class UdpReceiver {
 public:
  UdpReceiver(const Config& config, FrameQueue& latest, Metrics& metrics)
      : config_(config), metrics_(metrics), assembler_(latest, metrics) {}
  ~UdpReceiver() { stop(); }

  bool start() {
    fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd_ < 0) return fail("UDP socket");
    int enabled = 1;
    ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &enabled, sizeof(enabled));
    int receiveBuffer = 8 * 1024 * 1024;
    ::setsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &receiveBuffer, sizeof(receiveBuffer));
    socklen_t optionSize = sizeof(receiveBuffer);
    ::getsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &receiveBuffer, &optionSize);
    timeval timeout{0, 200000};
    ::setsockopt(fd_, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<std::uint16_t>(config_.udpPort));
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    if (::bind(fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      return fail("UDP bind");
    }
    running_ = true;
    thread_ = std::thread(&UdpReceiver::loop, this);
    log("Listening for UDP on :" + std::to_string(config_.udpPort) +
        " (buffer=" + std::to_string(receiveBuffer) + ")");
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
  bool fail(const char* action) {
    log(std::string(action) + " failed: " + std::strerror(errno));
    return false;
  }

  void loop() {
    std::vector<std::uint8_t> datagram(65536);
    while (running_) {
      const auto count = ::recvfrom(fd_, datagram.data(), datagram.size(), 0, nullptr, nullptr);
      if (count <= 0) continue;
      ++metrics_.packets;
      consume(datagram.data(), static_cast<std::size_t>(count));
    }
  }

  void consume(const std::uint8_t* data, std::size_t size) {
    std::size_t cursor = 0;
    while (size - cursor >= kFrameHeaderSize) {
      const auto* header = data + cursor;
      const auto type = header[0] & 0x7f;
      const auto chunkSize = static_cast<std::size_t>(u16le(header + 2));
      const auto sequence = u32le(header + 4);
      const auto frameSize = static_cast<std::size_t>(u32le(header + 8));
      const auto offset = static_cast<std::size_t>(u32le(header + 12));
      cursor += kFrameHeaderSize;
      if (chunkSize > size - cursor || frameSize == 0 || frameSize > kMaxFrameSize ||
          offset + chunkSize > frameSize) {
        return;
      }
      if (type == kJpegFrame) {
        assembler_.consume(type, sequence, frameSize, offset, data + cursor, chunkSize);
      }
      cursor += chunkSize;
    }
  }

  const Config& config_;
  Metrics& metrics_;
  FrameAssembler assembler_;
  int fd_ = -1;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

class TcpReceiver {
 public:
  TcpReceiver(const Config& config, FrameQueue& latest, Metrics& metrics)
      : config_(config), metrics_(metrics), assembler_(latest, metrics) {}
  ~TcpReceiver() { stop(); }

  bool start() {
    fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd_ < 0) return fail("TCP video socket");
    int receiveBuffer = 8 * 1024 * 1024;
    ::setsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &receiveBuffer, sizeof(receiveBuffer));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<std::uint16_t>(config_.tcpVideoPort));
    if (::inet_pton(AF_INET, config_.host.c_str(), &address.sin_addr) != 1) {
      log("Invalid camera IP: " + config_.host);
      return false;
    }
    if (::connect(fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) {
      return fail("TCP video connect");
    }
    running_ = true;
    thread_ = std::thread(&TcpReceiver::loop, this);
    log("Connected TCP video " + config_.host + ':' +
        std::to_string(config_.tcpVideoPort));
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
  bool fail(const char* action) {
    log(std::string(action) + " failed: " + std::strerror(errno));
    return false;
  }

  void loop() {
    std::uint64_t chunks = 0;
    while (running_) {
      std::uint8_t header[kFrameHeaderSize];
      if (!readExact(fd_, header, sizeof(header))) break;
      const auto type = header[0] & 0x7f;
      auto chunkSize = static_cast<std::size_t>(u16le(header + 2));
      const auto sequence = u32le(header + 4);
      const auto frameSize = static_cast<std::size_t>(u32le(header + 8));
      const auto offset = static_cast<std::size_t>(u32le(header + 12));
      if (chunkSize == 0 && offset == 0) chunkSize = frameSize;
      if (frameSize == 0 || frameSize > kMaxFrameSize || chunkSize == 0 ||
          offset + chunkSize > frameSize) {
        log("Invalid TCP video header; stopping receiver");
        break;
      }
      std::vector<std::uint8_t> chunk(chunkSize);
      if (!readExact(fd_, chunk.data(), chunk.size())) break;
      ++metrics_.packets;
      ++chunks;
      if (chunks <= 3) {
        log("TCP chunk #" + std::to_string(chunks) + " type=" +
            std::to_string(type) + " seq=" + std::to_string(sequence) +
            " chunk=" + std::to_string(chunkSize) + " frame=" +
            std::to_string(frameSize) + " offset=" + std::to_string(offset));
      }
      assembler_.consume(type, sequence, frameSize, offset, chunk.data(), chunk.size());
    }
    if (running_) log("TCP video receiver stopped");
    running_ = false;
  }

  const Config& config_;
  Metrics& metrics_;
  FrameAssembler assembler_;
  int fd_ = -1;
  std::atomic<bool> running_{false};
  std::thread thread_;
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
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS) != 0) {
    std::cerr << "SDL_Init failed: " << SDL_GetError() << '\n';
    return 1;
  }
  SDL_Window* window = SDL_CreateWindow(
      "Wi-Fi Backup Camera", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
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
  SDL_RendererInfo rendererInfo{};
  SDL_GetRendererInfo(renderer, &rendererInfo);
  log(std::string("SDL renderer=") + (rendererInfo.name ? rendererInfo.name : "unknown") +
      " vsync=" + ((rendererInfo.flags & SDL_RENDERER_PRESENTVSYNC) ? "on" : "off"));

  FrameQueue latest(config.bufferFrames);
  Metrics metrics;
  {
    std::ostringstream mode;
    mode << "Presentation mode="
         << (config.displayFps > 0.0 ? "paced" : "latest")
         << " buffer_frames=" << config.bufferFrames;
    if (config.displayFps > 0.0) mode << " display_fps=" << config.displayFps;
    log(mode.str());
  }
  ControlChannel control(config);
  if (!control.start()) {
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 1;
  }
  std::unique_ptr<UdpReceiver> udp;
  std::unique_ptr<TcpReceiver> tcp;
  bool videoStarted = false;
  if (config.transport == "tcp") {
    tcp = std::make_unique<TcpReceiver>(config, latest, metrics);
    videoStarted = tcp->start();
  } else {
    udp = std::make_unique<UdpReceiver>(config, latest, metrics);
    videoStarted = udp->start();
  }
  if (!videoStarted) {
    control.stop();
    if (tcp) tcp->stop();
    if (udp) udp->stop();
    SDL_DestroyRenderer(renderer);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 1;
  }
  control.openStream();

  SDL_Texture* texture = nullptr;
  int textureWidth = 0;
  int textureHeight = 0;
  std::vector<std::uint8_t> rgb;
  bool running = true;
  const auto started = std::chrono::steady_clock::now();
  const auto presentationInterval = config.displayFps > 0.0
      ? std::chrono::microseconds(
            static_cast<std::int64_t>(1000000.0 / config.displayFps))
      : std::chrono::microseconds(0);
  auto nextPresentation = started;
  bool presentationPrimed = config.bufferFrames == 1;
  auto lastTitleUpdate = started;
  auto lastStatsUpdate = started;
  std::uint64_t previousPackets = 0;
  std::uint64_t previousFrames = 0;
  std::uint64_t previousDisplayed = 0;
  std::uint64_t previousIncomplete = 0;
  std::uint64_t previousReplaced = 0;
  std::uint64_t previousSequenceGaps = 0;
  while (running) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
      if (event.type == SDL_QUIT) running = false;
      if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_ESCAPE) running = false;
    }

    const auto loopNow = std::chrono::steady_clock::now();
    if (!presentationPrimed && latest.size() >= config.bufferFrames) {
      presentationPrimed = true;
      nextPresentation = loopNow;
      log("Presentation buffer primed with " +
          std::to_string(config.bufferFrames) + " frames");
    }
    const bool presentationDue = presentationPrimed &&
        (config.displayFps == 0.0 || loopNow >= nextPresentation);
    std::optional<std::vector<std::uint8_t>> frame;
    if (presentationDue) {
      frame = latest.take();
      if (config.displayFps > 0.0) {
        nextPresentation += presentationInterval;
        if (nextPresentation + presentationInterval < loopNow) {
          nextPresentation = loopNow + presentationInterval;
        }
      }
    }

    if (frame) {
      int width = 0;
      int height = 0;
      const auto decodeStarted = std::chrono::steady_clock::now();
      const bool decoded = decodeJpeg(*frame, rgb, width, height);
      const auto decodeDuration = std::chrono::duration_cast<std::chrono::microseconds>(
                                      std::chrono::steady_clock::now() - decodeStarted)
                                      .count();
      if (decodeDuration >= 0) {
        metrics.decodeUs.fetch_add(static_cast<std::uint64_t>(decodeDuration),
                                   std::memory_order_relaxed);
        metrics.decodeSamples.fetch_add(1, std::memory_order_relaxed);
        atomicMax(metrics.decodeMaxUs, static_cast<std::uint64_t>(decodeDuration));
      }
      if (decoded) {
        if (!texture || width != textureWidth || height != textureHeight) {
          if (texture) SDL_DestroyTexture(texture);
          texture = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGB24,
                                      SDL_TEXTUREACCESS_STREAMING, width, height);
          textureWidth = width;
          textureHeight = height;
          log("Decoded stream resolution=" + std::to_string(width) + "x" +
              std::to_string(height));
          if (width != config.width || height != config.height) {
            log("WARNING camera ignored requested resolution=" +
                std::to_string(config.width) + "x" +
                std::to_string(config.height));
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

    const auto now = std::chrono::steady_clock::now();
    if (now - lastTitleUpdate >= std::chrono::milliseconds(500)) {
      const double seconds = std::chrono::duration<double>(now - started).count();
      const double fps = seconds > 0 ? metrics.frames.load() / seconds : 0;
      std::ostringstream title;
      title << "Wi-Fi Backup Camera — " << std::fixed << std::setprecision(1) << fps
            << " fps — packets " << metrics.packets.load() << " — incomplete "
            << metrics.incomplete.load() << " — queue " << latest.size() << '/'
            << config.bufferFrames << " — replaced " << metrics.replaced.load();
      SDL_SetWindowTitle(window, title.str().c_str());
      lastTitleUpdate = now;
    }

    if (now - lastStatsUpdate >= std::chrono::seconds(2)) {
      const double interval = std::chrono::duration<double>(now - lastStatsUpdate).count();
      const auto packets = metrics.packets.load();
      const auto frames = metrics.frames.load();
      const auto displayed = metrics.displayed.load();
      const auto incomplete = metrics.incomplete.load();
      const auto replaced = metrics.replaced.load();
      const auto sequenceGaps = metrics.sequenceGaps.load();
      const auto arrivalSamples = metrics.arrivalGapSamples.exchange(0);
      const auto arrivalUs = metrics.arrivalGapUs.exchange(0);
      const auto arrivalMaxUs = metrics.arrivalGapMaxUs.exchange(0);
      const auto decodeSamples = metrics.decodeSamples.exchange(0);
      const auto decodeUs = metrics.decodeUs.exchange(0);
      const auto decodeMaxUs = metrics.decodeMaxUs.exchange(0);

      std::ostringstream stats;
      stats << std::fixed << std::setprecision(1)
            << "STATS source=" << (frames - previousFrames) / interval
            << "fps display=" << (displayed - previousDisplayed) / interval
            << "fps packets=" << (packets - previousPackets) / interval << "/s"
            << " incomplete=" << incomplete << "(+" << (incomplete - previousIncomplete)
            << ") replaced=" << replaced << "(+" << (replaced - previousReplaced)
            << ") seq_gaps=" << sequenceGaps << "(+"
            << (sequenceGaps - previousSequenceGaps) << ") queue="
            << latest.size() << '/' << config.bufferFrames << " arrival_avg="
            << (arrivalSamples ? (arrivalUs / 1000.0) / arrivalSamples : 0.0)
            << "ms arrival_max=" << arrivalMaxUs / 1000.0 << "ms decode_avg="
            << (decodeSamples ? (decodeUs / 1000.0) / decodeSamples : 0.0)
            << "ms decode_max=" << decodeMaxUs / 1000.0 << "ms decode_fail="
            << metrics.decodeFailures.load();
      log(stats.str());

      previousPackets = packets;
      previousFrames = frames;
      previousDisplayed = displayed;
      previousIncomplete = incomplete;
      previousReplaced = replaced;
      previousSequenceGaps = sequenceGaps;
      lastStatsUpdate = now;
    }
  }

  control.stop();
  if (tcp) tcp->stop();
  if (udp) udp->stop();
  if (texture) SDL_DestroyTexture(texture);
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return 0;
}
