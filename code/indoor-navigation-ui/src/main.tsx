import "@fortawesome/fontawesome-free/css/all.min.css";
import "mdb-react-ui-kit/dist/css/mdb.min.css";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import SandboxApp from "../sandbox/sb_SandboxApp.tsx";
import "./index.css";

const normalizedPath = window.location.pathname.replace(/\/+$/, "") || "/";
const rootApp = normalizedPath === "/sandbox" ? <SandboxApp /> : <App />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  // <React.StrictMode>
  //   <App />
  // </React.StrictMode>
  rootApp
);
