import { useState } from "react";
import { MDBBtn, MDBInput } from "mdb-react-ui-kit";
import { loginSandboxAdmin, setSandboxAuthState } from "../sb_auth";

export default function SandboxLoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError("");
    try {
      const result = await loginSandboxAdmin(username, password);
      if (!result.ok || !result.username || !result.authorization) {
        setError(result.error || "Unable to open sandbox.");
        return;
      }
      setSandboxAuthState({
        loggedIn: true,
        username: result.username,
        authorization: result.authorization,
      });
      setPassword("");
      window.location.hash = "#/configurator";
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="sandbox-login-shell">
      <section className="sandbox-login-card">
        <div className="sandbox-login-eyebrow">
          <i className="fas fa-flask" aria-hidden="true" />
          Admin-only sandbox
        </div>
        <h1 className="sandbox-login-title">Sandbox Layout Builder</h1>
        <p className="sandbox-login-copy">
          Changes made here stay in the sandbox tables and do not replace the live map layout.
        </p>
        <form className="sandbox-login-form" onSubmit={submit}>
          <MDBInput
            label="Admin Username"
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <MDBInput
            label="Admin Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? <div className="text-danger small">{error}</div> : null}
          <div className="sandbox-login-actions">
            <MDBBtn type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Opening..." : "Open Sandbox"}
            </MDBBtn>
            <MDBBtn type="button" color="light" onClick={() => (window.location.href = "/")}>
              Back To Live App
            </MDBBtn>
          </div>
        </form>
        <p className="sandbox-login-hint">
          URL: <code>http://localhost:5173/sandbox</code>
        </p>
      </section>
    </main>
  );
}
