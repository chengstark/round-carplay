import { useEffect, useState } from "react";
import { HashRouter as Router, Route, Routes } from "react-router-dom";
import Settings from "./components/Settings";
import Info from "./components/Info";
import Home from "./components/Home";
import Nav from "./components/Nav";
import Carplay from './components/Carplay';
import Camera from './components/Camera';
import { Box, Modal } from '@mui/material';
import { useCarplayStore, useStatusStore } from "./store/store";
import type { KeyCommand } from "./components/worker/types";
import { updateCameras } from "./utils/cameraDetection";

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

const BACKGROUND = 'rgb(160, 186, 204)';

// The CarPlay square is a plain block in the circle's top-left corner, nudged into the
// middle by translate(22%, 22%) — 22% of its own 69% size. Its bottom edge therefore
// sits at 69 * 1.22 = 84.18% of the circle's diameter. Keep the circle a block element:
// giving it display:flex would centre the square first and the translate would then
// shove it out of the circle.
const SQUARE_SIZE_PCT = 69;
const SQUARE_SHIFT_PCT = 22;
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


function App() {
  const [time, setTime] = useState(new Date());
  const [receivingVideo, setReceivingVideo] = useState(false);
  const [commandCounter, setCommandCounter] = useState(0);
  const [keyCommand, setKeyCommand] = useState('');

  const reverse = useStatusStore(state => state.reverse);
  const setReverse = useStatusStore(state => state.setReverse);

  const settings = useCarplayStore(state => state.settings);
  const saveSettings = useCarplayStore(state => state.saveSettings);
  const setCameraFound = useStatusStore(state => state.setCameraFound);

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
      style={{ touchAction: 'none', backgroundColor: BACKGROUND }}
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
          backgroundColor: BACKGROUND,
          border: "0px solid red"
        }}
      >

        {/* Inner CarPlay square */}
        <div
          className="flex items-center justify-center"
          style={{
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
          </div>
        </div>

        {/* Filler artwork in the ring below the CarPlay square */}
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

        {/* Clock in outer ring */}
        <div
          style={{
            position: "absolute",
            top: "4%",
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: "min(6vw, 6vh)",
            fontWeight: 500,
            color: "white",
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

      </div>
    </div>
  </Router>
);
}

export default App;
