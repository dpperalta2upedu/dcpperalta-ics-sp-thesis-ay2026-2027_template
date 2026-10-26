import { useEffect, useState } from "react";
import SandboxHome from "./components/sb_SandboxHome";
import SandboxLayoutBuilder from "./components/sb_SandboxLayoutBuilder";
import { AUTH_CHANGED_EVENT, getAuthState } from "../src/utils/auth";
import { clearSandboxAuthState } from "./sb_auth";
import "./sb_sandbox.css";

const getSandboxPageFromHash = (): "home" | "configurator" =>
  window.location.hash === "#/configurator" ? "configurator" : "home";

export default function SandboxApp() {
  const [page, setPage] = useState<"home" | "configurator">(getSandboxPageFromHash());

  useEffect(() => {
    document.title = "Indoor Navigation Sandbox";
    const syncHash = () => setPage(getSandboxPageFromHash());
    const syncLiveAuth = () => {
      if (getAuthState().loggedIn) {
        return;
      }
      clearSandboxAuthState();
      window.location.href = "/";
    };
    syncLiveAuth();
    window.addEventListener(AUTH_CHANGED_EVENT, syncLiveAuth);
    window.addEventListener("storage", syncLiveAuth);
    window.addEventListener("hashchange", syncHash);
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, syncLiveAuth);
      window.removeEventListener("storage", syncLiveAuth);
      window.removeEventListener("hashchange", syncHash);
    };
  }, []);

  return page === "configurator" ? <SandboxLayoutBuilder /> : <SandboxHome />;
}
