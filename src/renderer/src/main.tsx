import './api/browserApi'
import ReactDOM from 'react-dom/client'
import App from './App'
import PlayPortSurface from './components/PlayPortSurface'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { useCarplayStore } from './store/store'
import { darkTheme, lightTheme } from './theme'
import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'

const nativePreview = new URLSearchParams(location.search).get('view') === 'native'
if (nativePreview) document.title = 'Native CarPlay'

const Root = () => {
  const settings = useCarplayStore(state => state.settings);
  const theme = settings ? (settings.nightMode ? darkTheme : lightTheme) : darkTheme;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {nativePreview
        ? <div className="native-preview"><PlayPortSurface view="map" native /></div>
        : <App />}
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <Root />
);
