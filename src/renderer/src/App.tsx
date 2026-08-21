import { useEffect, useState } from "react";
import { HashRouter as Router, Route, Routes } from "react-router-dom";
import Settings from "./components/Settings";
import Info from "./components/Info";
import Home from "./components/Home";
import Nav from "./components/Nav";
import Carplay from './components/Carplay';
import Camera from './components/Camera';
import WifiCamera from './components/WifiCamera';
import SystemMenu from './components/SystemMenu';
import { Box, IconButton, Modal } from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import { useCarplayStore, useStatusStore } from "./store/store";
import type { KeyCommand } from "./components/worker/types";
import { updateCameras } from "./utils/cameraDetection";
import PorscheClock from "./components/clock/PorscheClock";
import CrescentButton from "./components/clock/CrescentButton";
import { useDoubleTap } from "./components/clock/useDoubleTap";
import type { GpsState } from "../../main/gps/GpsService";

const style = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  height: '95%',
  width: '95%',
  boxShadow: 24,
  display: "flex"
};

const DEFAULT_BACKGROUND = '#000000';

// The CarPlay square is a plain block in the circle's top-left corner, nudged into the
// middle by a translate of SQUARE_SHIFT_PCT — a percentage of the square's *own* size, so
// it has to track the size. The formula below centres the square in the circle (it gives
// 22.5% at the old 69% size, matching the hand-tuned value it replaces), leaving
// SQUARE_SIZE_PCT as the only knob. Keep the circle a block element: giving it display:flex
// would centre the square first and the translate would then shove it out of the circle.
//
// Upper bound: a centred square with SQUARE_RADIUS_PCT corners stays inside the circle up to
// ~74%; past that the corners are clipped by the circle's overflow:hidden. Growing the
// square also eats into the ring below it, so the filler artwork shrinks to match.
const SQUARE_SIZE_PCT = 72;
const SQUARE_SHIFT_PCT = 5000 / SQUARE_SIZE_PCT - 50;
const SQUARE_BOTTOM_PCT = SQUARE_SIZE_PCT * (1 + SQUARE_SHIFT_PCT / 100);

// Rounded corners on the CarPlay area. As a percentage it scales with the display;
// the element is square, so both axes get the same radius and the arcs stay circular.
const SQUARE_RADIUS_PCT = 8;

// Filler artwork in the ring below the square, with a margin between the two.
const FILLER_MARGIN_PCT = 1.6;
const FILLER_TOP_PCT = SQUARE_BOTTOM_PCT + FILLER_MARGIN_PCT;
const FILLER_HEIGHT_PCT = 98.6 - FILLER_TOP_PCT;

// SCfiller.png is a square canvas and the car does not fill it: the opaque pixels run
// from 10.7% to 78.7% of the image height. Scale and offset the <img> by those fractions
// so the *car* lands in the band above, instead of the padded canvas. Re-measure these
// two numbers if the artwork is ever replaced with a differently padded one.
const ART_TOP_FRACTION = 0.107;
const ART_HEIGHT_FRACTION = 0.68;
const FILLER_IMG_HEIGHT_PCT = FILLER_HEIGHT_PCT / ART_HEIGHT_FRACTION;
const FILLER_IMG_TOP_PCT = FILLER_TOP_PCT - FILLER_IMG_HEIGHT_PCT * ART_TOP_FRACTION;

// The clock button claims the whole empty crescent to the left of the CarPlay
// square — the largest target the layout can give a driver — and CrescentButton
// draws that lune as a visible shape so the region reads as a button rather than
// as empty ring that happens to be tappable. Both numbers derive from the
// square, so resizing CarPlay reshapes the button with it.
const SQUARE_LEFT_PCT = SQUARE_SIZE_PCT * (SQUARE_SHIFT_PCT / 100);

// Gap between the button's inner edge and the CarPlay square. It started at the
// filler artwork's 1.6% and was tightened to bring the button closer to CarPlay;
// the 1.1% difference is about 1mm on a 3.5-4in panel, nearer 0.6mm on a 2.1in
// one, so nudge this down again if the display is smaller than that.
//
// The button grows rightwards rather than sliding: its outer arc has to stay
// pinned to the edge of the display, or a sliver of bare ring opens up outside
// it. Lower bound is roughly 0.2% — below that the button's tips foul the
// square's rounded corners, which sit inboard of its straight edge.
const CLOCK_BUTTON_GAP_PCT = 0.5;
const CLOCK_BUTTON_RIGHT_PCT = SQUARE_LEFT_PCT - CLOCK_BUTTON_GAP_PCT;
const SQUARE_RIGHT_PCT = SQUARE_LEFT_PCT + SQUARE_SIZE_PCT;
const CAMERA_BUTTON_LEFT_PCT = SQUARE_RIGHT_PCT + CLOCK_BUTTON_GAP_PCT;

const INITIAL_GPS_STATE: GpsState = {
  status: 'connecting',
  hasFix: false,
  speedMph: null,
  satellites: 0,
  message: 'Waiting for GPS data'
};

function contrastText(backgroundColor: string): '#111111' | '#ffffff' {
  const red = Number.parseInt(backgroundColor.slice(1, 3), 16);
  const green = Number.parseInt(backgroundColor.slice(3, 5), 16);
  const blue = Number.parseInt(backgroundColor.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 255000;
  return luminance > 0.58 ? '#111111' : '#ffffff';
}


function App() {
  const [time, setTime] = useState(new Date());
  const [clockMode, setClockMode] = useState(false);
  const [wifiCameraMode, setWifiCameraMode] = useState(false);
  const [systemMenuOpen, setSystemMenuOpen] = useState(false);
  const [showGpsSpeed, setShowGpsSpeed] = useState(false);
  const [gpsState, setGpsState] = useState<GpsState>(INITIAL_GPS_STATE);
  const [receivingVideo, setReceivingVideo] = useState(false);
  const [commandCounter, setCommandCounter] = useState(0);
  const [keyCommand, setKeyCommand] = useState('');

  const reverse = useStatusStore(state => state.reverse);
  const setReverse = useStatusStore(state => state.setReverse);

  const clockButton = useDoubleTap(() => setClockMode(true));
  const wifiCameraButton = useDoubleTap(() => setWifiCameraMode(active => !active));

  const settings = useCarplayStore(state => state.settings);
  const saveSettings = useCarplayStore(state => state.saveSettings);
  const setCameraFound = useStatusStore(state => state.setCameraFound);
  const backgroundColor = settings?.backgroundColor ?? DEFAULT_BACKGROUND;
  const surroundTextColor = contrastText(backgroundColor);

  const openSystemMenu = () => {
    setWifiCameraMode(false);
    setSystemMenuOpen(true);
  };

  const changeBackgroundColor = (color: string) => {
    if (settings) saveSettings({ ...settings, backgroundColor: color });
  };

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [settings]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!settings) return;

    if (Object.values(settings.bindings).includes(event.code)) {
      const action = Object.keys(settings.bindings).find(
        key => settings.bindings[key] === event.code
      );
      if (action !== undefined) {
        setKeyCommand(action);
        setCommandCounter(prev => prev + 1);
        if (action === 'selectDown') {
          setTimeout(() => {
            setKeyCommand('selectUp');
            setCommandCounter(prev => prev + 1);
          }, 200);
        }
      }
    }
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 30000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const removeGpsListener = window.carplay.gps.onState(state => {
      if (active) setGpsState(state);
    });

    window.carplay.gps.getState()
      .then(state => {
        if (active) setGpsState(state);
      })
      .catch(error => console.warn('[GPS] Could not get initial state', error));

    return () => {
      active = false;
      removeGpsListener();
    };
  }, []);

  useEffect(() => {
    if (!settings) return;

    updateCameras(setCameraFound, saveSettings, settings);

    const usbHandler = (_: any, data: { type: string }) => {
      if (['attach', 'plugged', 'detach', 'unplugged'].includes(data.type)) {
        updateCameras(setCameraFound, saveSettings, settings);
      }
    };

    window.carplay.usb.listenForEvents(usbHandler);
    return () => window.carplay.usb.unlistenForEvents?.(usbHandler);
  }, [settings]);

  return (
  <Router>
    {/* Schermo intero (kiosk) */}
    <div
      className="w-screen h-screen flex items-center justify-center"
      style={{ touchAction: 'none', backgroundColor }}
    >
      {/* Outer round display */}
      <div
        className="relative flex items-center justify-center"
        style={{
          position: "relative",
          width: "min(100vw, 100vh)",
          height: "min(100vw, 100vh)",
          borderRadius: "50%",
          overflow: "hidden",
          backgroundColor,
          border: "0px solid red"
        }}
      >

        {/* Inner CarPlay square */}
        <div
          className="flex items-center justify-center"
          style={{
            position: "relative",
            width: `${SQUARE_SIZE_PCT}%`,
            height: `${SQUARE_SIZE_PCT}%`,
            transform: `translate(${SQUARE_SHIFT_PCT}%, ${SQUARE_SHIFT_PCT}%)`,
            borderRadius: `${SQUARE_RADIUS_PCT}%`,
            overflow: "hidden",
            border: "0px solid lime"
          }}
        >
          <div className="w-full h-full flex items-center justify-center">
            <Nav receivingVideo={receivingVideo} settings={settings} />

            {settings && (
              <Carplay
                receivingVideo={receivingVideo}
                setReceivingVideo={setReceivingVideo}
                settings={settings}
                command={keyCommand as KeyCommand}
                commandCounter={commandCounter}
              />
            )}

            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/settings" element={<Settings settings={settings!} />} />
              <Route path="/info" element={<Info />} />
              <Route path="/camera" element={<Camera settings={settings!} />} />
            </Routes>

            <Modal open={reverse} onClick={() => setReverse(false)}>
              <Box sx={style}>
                <Camera settings={settings} />
              </Box>
            </Modal>

            {systemMenuOpen && (
              <SystemMenu
                backgroundColor={backgroundColor}
                onBackgroundColorChange={changeBackgroundColor}
                onClose={() => setSystemMenuOpen(false)}
              />
            )}
          </div>
        </div>

        {/* The bottom filler is also the GPS speedometer switch. The transparent
            button covers the visible car rather than the padded image canvas,
            so the target remains generous without stealing taps from CarPlay. */}
        {!showGpsSpeed && (
          <img
            src="SCfiller.png"
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              top: `${FILLER_IMG_TOP_PCT}%`,
              height: `${FILLER_IMG_HEIGHT_PCT}%`,
              left: "50%",
              transform: "translateX(-50%)",
              width: "68%",
              objectFit: "contain",
              pointerEvents: "none",
              userSelect: "none"
            }}
          />
        )}

        {showGpsSpeed && (
          <div
            aria-live="polite"
            style={{
              position: "absolute",
              top: `${FILLER_TOP_PCT - 0.8}%`,
              left: "50%",
              transform: "translateX(-50%)",
              width: "58%",
              height: `${FILLER_HEIGHT_PCT + 0.8}%`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "min(1.1vw, 1.1vh)",
              color: surroundTextColor,
              textShadow: surroundTextColor === '#ffffff'
                ? "0 1px 2px rgba(0,0,0,0.75)"
                : "0 1px 1px rgba(255,255,255,0.5)",
              pointerEvents: "none",
              userSelect: "none",
              zIndex: 7
            }}
          >
            <span
              style={{
                fontFamily: "'Roboto Condensed', 'Arial Narrow', sans-serif",
                fontSize: "min(8.5vw, 8.5vh)",
                fontWeight: 700,
                fontVariantNumeric: "tabular-nums",
                lineHeight: 1
              }}
            >
              {gpsState.hasFix && gpsState.speedMph != null
                ? Math.round(gpsState.speedMph)
                : '--'}
            </span>
            <span
              style={{
                alignSelf: "flex-end",
                marginBottom: "14%",
                fontSize: "min(2.2vw, 2.2vh)",
                fontWeight: 700,
                letterSpacing: "0.12em",
                lineHeight: 1
              }}
            >
              MPH
            </span>
          </div>
        )}

        <button
          type="button"
          aria-label={showGpsSpeed ? 'Show car artwork' : 'Show GPS speed'}
          title={showGpsSpeed ? gpsState.message : 'Show GPS speed'}
          onClick={() => setShowGpsSpeed(current => !current)}
          style={{
            position: "absolute",
            top: `${FILLER_TOP_PCT}%`,
            left: "50%",
            transform: "translateX(-50%)",
            width: "58%",
            height: `${FILLER_HEIGHT_PCT}%`,
            padding: 0,
            border: 0,
            background: "transparent",
            cursor: "default",
            touchAction: "manipulation",
            zIndex: 8
          }}
        />

        {/* Clock in outer ring */}
        <div
          style={{
            position: "absolute",
            top: "4%",
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: "min(6vw, 6vh)",
            fontWeight: 500,
            color: surroundTextColor,
            textShadow: "0 0 6px rgba(0,0,0,0.7)",
            zIndex: 10,
            whiteSpace: "nowrap",
          }}
        >
          {time.toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </div>

        {/* System menu lives in the surround, while its panel replaces only
            the central CarPlay square. Closing it reveals the still-mounted
            CarPlay surface immediately. */}
        <IconButton
          aria-label="Open system menu"
          title="System menu"
          onClick={openSystemMenu}
          sx={{
            position: 'absolute',
            top: '4%',
            right: '27%',
            zIndex: 12,
            width: 'min(8vw, 8vh)',
            height: 'min(8vw, 8vh)',
            minWidth: 36,
            minHeight: 36,
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.55)',
            backgroundColor: 'rgba(0,0,0,0.68)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
            '&:hover': { backgroundColor: 'rgba(0,0,0,0.68)' }
          }}
        >
          <MenuIcon sx={{ fontSize: 'min(4.6vw, 4.6vh)' }} />
        </IconButton>

        {/* Clock button: the whole crescent left of CarPlay, drawn as a visible
            shape. Double-tap to open, so a hand brushing the panel can't swap
            the display mid-drive; the first tap lights the crescent so the
            control shows it heard you. The icon is the dial itself, running
            live, so it doubles as a small gauge while CarPlay is up. */}
        <CrescentButton
          edgePct={CLOCK_BUTTON_RIGHT_PCT}
          side="left"
          armed={clockButton.armed}
          onClick={clockButton.onClick}
          finish="graphite"
        />

        {/* Matching control in the right crescent. It toggles the integrated
            JieLi Wi-Fi camera path; the existing USB camera route remains
            available from the CarPlay navigation tabs. Keeping this button
            above the video surface lets the same double-tap close it again. */}
        <CrescentButton
          edgePct={CAMERA_BUTTON_LEFT_PCT}
          side="right"
          armed={wifiCameraButton.armed}
          onClick={wifiCameraButton.onClick}
          finish="graphite"
          content="camera"
        />

        {wifiCameraMode && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 9,
              touchAction: "none"
            }}
          >
            <WifiCamera
              rotation={settings?.wifiCameraRotation ?? 0}
              onRotationSave={rotation => {
                if (settings) saveSettings({ ...settings, wifiCameraRotation: rotation });
              }}
            />
          </div>
        )}

        {/* Clock mode: covers the whole round display rather than replacing the
            view, so CarPlay stays mounted and streaming underneath and coming
            back is instant. Tap the face to return. */}
        {clockMode && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: "#000",
              zIndex: 20,
              touchAction: "none"
            }}
          >
            <PorscheClock variant="full" onExit={() => setClockMode(false)} />
          </div>
        )}

      </div>
    </div>
  </Router>
);
}

export default App;
