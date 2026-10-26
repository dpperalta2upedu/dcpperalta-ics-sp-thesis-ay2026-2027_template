import { useEffect, useState } from "react";
import Home from "./components/Home";
import LayoutBuilder from "./components/LayoutBuilder";
import "mdb-react-ui-kit/dist/css/mdb.min.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import { AUTH_CHANGED_EVENT, getAuthState, initAuthSessionWatcher } from "./utils/auth";

const getPageFromHash = (): "home" | "configurator" =>
  window.location.hash === "#/configurator" ? "configurator" : "home";

function App() {
  const [page, setPage] = useState<"home" | "configurator">(getPageFromHash());
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(() => getAuthState().loggedIn);

  useEffect(() => {
    initAuthSessionWatcher();
    const onHashChange = () => setPage(getPageFromHash());
    const onAuthChange = () => setIsLoggedIn(getAuthState().loggedIn);
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChange);
    window.addEventListener("storage", onAuthChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChange);
      window.removeEventListener("storage", onAuthChange);
    };
  }, []);

  const canOpenConfigurator = isLoggedIn;
  const effectivePage = page === "configurator" && !canOpenConfigurator ? "home" : page;

  return (
    <div>
      {effectivePage === "home" ? <Home /> : <LayoutBuilder />}
    </div>
  );
}

export default App;
