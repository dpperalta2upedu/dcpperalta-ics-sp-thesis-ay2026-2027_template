import { MDBFooter } from "mdb-react-ui-kit";
import "../sb_sandbox.css";

export default function SandboxFooter() {
  return (
    <MDBFooter className="text-center sandbox-footer">
      <div className="text-center p-2 sandbox-footer-inner">
        <span className="sandbox-footer-text">Sandbox workspace for indoor navigation layouts</span>
      </div>
    </MDBFooter>
  );
}
