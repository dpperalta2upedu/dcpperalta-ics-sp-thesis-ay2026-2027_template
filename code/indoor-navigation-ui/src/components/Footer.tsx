import { MDBFooter } from "mdb-react-ui-kit";

export default function Footer() {
  return (
    <MDBFooter className="text-center" color="white" bgColor="dark">
      <div
        className="text-center p-2"
        style={{ backgroundColor: "rgba(0, 0, 0, 0.2)" }}
      >
        <a className="text-white" href="#">
          Physical Sciences Building, Harold Cuzner Royal Palm Ave, Batong Malake, Los Baños, Laguna
        </a>
      </div>
    </MDBFooter>
  );
}
