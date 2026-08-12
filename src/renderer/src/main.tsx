import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { useCarplayStore } from './store/store'
import { darkTheme, lightTheme, initCursorHider } from './theme'
import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'

// 0 = never show the pointer. This is a touch panel; the idle-timeout mode left
// the cursor on screen for the first five seconds after boot and brought it back
// on any mouse movement. Pass a millisecond value here to get that back on a
// desktop, where you do need to see what you're clicking.
initCursorHider(0);

const Root = () => {
  const settings = useCarplayStore(state => state.settings);
  const theme = settings ? (settings.nightMode ? darkTheme : lightTheme) : darkTheme;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <Root />
);

