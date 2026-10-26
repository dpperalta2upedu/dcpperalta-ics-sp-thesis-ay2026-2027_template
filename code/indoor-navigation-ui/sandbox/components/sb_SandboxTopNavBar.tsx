import { MDBBtn, MDBNavbar, MDBNavbarBrand } from "mdb-react-ui-kit";
import "../../src/assets/home.css";

export default function SandboxTopNavBar() {
  const isConfiguratorPage = window.location.hash === "#/configurator";

  return (
    <MDBNavbar expand="lg" sticky dark bgColor="success" className="py-2 top-nav-glow sandbox-top-nav">
      <div className="d-flex align-items-center justify-content-between top-nav-inner">
        <MDBNavbarBrand
          href="/sandbox"
          className="d-flex align-items-center py-1 mb-0 top-nav-brand sandbox-top-nav-brand"
        >
          <b className="top-nav-brand-text">Indoor Navigation Sandbox</b>
        </MDBNavbarBrand>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          <MDBBtn
            type="button"
            size="sm"
            className="top-nav-config-btn"
            onClick={() => {
              window.location.hash = isConfiguratorPage ? "#/" : "#/configurator";
            }}
          >
            {isConfiguratorPage ? "Sandbox Navigation Search" : "Sandbox Layout Builder"}
          </MDBBtn>
          <MDBBtn
            type="button"
            size="sm"
            className="top-nav-login-btn"
            onClick={() => {
              window.location.href = "/";
            }}
          >
            Exit Sandbox
          </MDBBtn>
        </div>
      </div>
    </MDBNavbar>
  );
}
