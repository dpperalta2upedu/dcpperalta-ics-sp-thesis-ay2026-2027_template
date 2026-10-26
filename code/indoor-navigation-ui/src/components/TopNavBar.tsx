import { useEffect, useState } from "react";
import {
  // MDBCollapse,
  MDBBtn,
  MDBInput,
  MDBModal,
  MDBModalBody,
  MDBModalContent,
  MDBModalDialog,
  MDBModalFooter,
  MDBModalHeader,
  MDBModalTitle,
  MDBNavbar,
  MDBNavbarBrand,
  // MDBNavbarItem,
  // MDBNavbarNav
} from "mdb-react-ui-kit";
import {
  AUTH_CHANGED_EVENT,
  clearAuthState,
  consumeAuthExpiredNotice,
  getAuthState,
  setAuthState,
} from "../utils/auth";
import { changeAdminPassword, loginAdmin, logoutAdmin } from "../services/authService";
import { clearSandboxAuthState, setSandboxAuthFromAdminCredentials } from "../../sandbox/sb_auth";

export default function TopNavBar() {
  const [loginModalOpen, setLoginModalOpen] = useState<boolean>(false);
  const [changePasswordModalOpen, setChangePasswordModalOpen] = useState<boolean>(false);
  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [changePasswordUsername, setChangePasswordUsername] = useState<string>("");
  const [currentPassword, setCurrentPassword] = useState<string>("");
  const [newPassword, setNewPassword] = useState<string>("");
  const [confirmNewPassword, setConfirmNewPassword] = useState<string>("");
  const [loginError, setLoginError] = useState<string>("");
  const [changePasswordError, setChangePasswordError] = useState<string>("");
  const [toast, setToast] = useState<{ message: string; tone: "success" | "warning" } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isChangingPassword, setIsChangingPassword] = useState<boolean>(false);
  const [showLoginPassword, setShowLoginPassword] = useState<boolean>(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState<boolean>(false);
  const [showNewPassword, setShowNewPassword] = useState<boolean>(false);
  const [showConfirmNewPassword, setShowConfirmNewPassword] = useState<boolean>(false);
  const [auth, setAuth] = useState(() => getAuthState());

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      setToast(null);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (message: string, tone: "success" | "warning" = "success") => {
    setToast({ message, tone });
  };

  const resetLoginValidationState = () => {
    setLoginError("");
    setIsSubmitting(false);
  };

  useEffect(() => {
    const syncAuth = () => {
      const nextAuth = getAuthState();
      if (!nextAuth.loggedIn) {
        clearSandboxAuthState();
      }
      setAuth(nextAuth);
      if (!nextAuth.loggedIn && consumeAuthExpiredNotice()) {
        showToast("You were logged out because your 8-hour session expired.", "warning");
      }
    };
    window.addEventListener(AUTH_CHANGED_EVENT, syncAuth);
    window.addEventListener("storage", syncAuth);
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, syncAuth);
      window.removeEventListener("storage", syncAuth);
    };
  }, []);

  const isConfiguratorPage = window.location.hash === "#/configurator";

  const closeChangePasswordModal = () => {
    setChangePasswordModalOpen(false);
    setChangePasswordUsername("");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmNewPassword("");
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowConfirmNewPassword(false);
    setChangePasswordError("");
  };

  const openChangePasswordModal = () => {
    setChangePasswordUsername(username.trim() || auth.username.trim());
    setCurrentPassword("");
    setNewPassword("");
    setConfirmNewPassword("");
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowConfirmNewPassword(false);
    setChangePasswordError("");
    setChangePasswordModalOpen(true);
  };

  const closeLoginModal = () => {
    setLoginModalOpen(false);
    resetLoginValidationState();
    setPassword("");
    setShowLoginPassword(false);
    closeChangePasswordModal();
  };

  const submitLogin = async () => {
    if (isSubmitting) return;
    const nextUsername = username.trim();
    const nextPassword = password;
    if (!nextUsername || !nextPassword) {
      setIsSubmitting(false);
      setLoginError("Username and password are required.");
      return;
    }

    try {
      setIsSubmitting(true);
      setLoginError("");
      const result = await loginAdmin(nextUsername, nextPassword);
      if (!result.ok) {
        setIsSubmitting(false);
        setLoginError(result.error || "Invalid username or password");
        return;
      }

      const loggedInUsername = (result.username || nextUsername).trim();
      setSandboxAuthFromAdminCredentials(loggedInUsername, nextPassword);
      setAuthState({ loggedIn: true, username: loggedInUsername });
      setAuth({ loggedIn: true, username: loggedInUsername });
      setToast(null);
      closeLoginModal();
      window.location.hash = "#/configurator";
    } finally {
      setIsSubmitting(false);
    }
  };

  const onLoginFormSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void submitLogin();
  };

  const logout = async () => {
    try {
      await logoutAdmin();
    } catch {
      // best effort
    }
    clearSandboxAuthState();
    clearAuthState();
    setAuth({ loggedIn: false, username: "" });
    setToast(null);
    closeLoginModal();
    closeChangePasswordModal();
    if (isConfiguratorPage) {
      window.location.hash = "#/";
    }
  };

  const submitChangePassword = async () => {
    const nextUsername = changePasswordUsername.trim();
    if (!nextUsername) {
      setChangePasswordError("Username is required.");
      return;
    }
    if (!currentPassword.trim() || !newPassword.trim() || !confirmNewPassword.trim()) {
      setChangePasswordError("All password fields are required.");
      return;
    }
    if (
      currentPassword !== currentPassword.trim() ||
      newPassword !== newPassword.trim() ||
      confirmNewPassword !== confirmNewPassword.trim()
    ) {
      setChangePasswordError("Passwords cannot start or end with spaces.");
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setChangePasswordError("New passwords do not match.");
      return;
    }
    if (newPassword.length < 8) {
      setChangePasswordError("New password must be at least 8 characters.");
      return;
    }
    if (newPassword === currentPassword) {
      setChangePasswordError("New password must be different from current password.");
      return;
    }

    try {
      setIsChangingPassword(true);
      setChangePasswordError("");
      const result = await changeAdminPassword(
        nextUsername,
        currentPassword,
        newPassword,
        confirmNewPassword
      );
      if (!result.ok) {
        setChangePasswordError(result.error || "Invalid username or current password");
        return;
      }
      closeChangePasswordModal();
      if (auth.loggedIn && auth.username.trim() === nextUsername) {
        try {
          await logoutAdmin();
        } catch {
          // best effort
        }
        clearSandboxAuthState();
        clearAuthState();
        setAuth({ loggedIn: false, username: "" });
        showToast("Password changed successfully. Please log in again.");
      } else {
        showToast("Password changed successfully.");
      }
      if (isConfiguratorPage) {
        window.location.hash = "#/";
      }
    } finally {
      setIsChangingPassword(false);
    }
  };

  const onChangePasswordFormSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    void submitChangePassword();
  };

  return (
    <>
      <MDBNavbar
        expand="lg"
        sticky
        dark
        bgColor="primary"
        className="py-2 top-nav-glow"
      >
        <div className="d-flex align-items-center justify-content-between top-nav-inner">
          <MDBNavbarBrand
            href="#"
            className="d-flex align-items-center py-1 mb-0 top-nav-brand top-nav-brand-live"
            style={{ fontSize: "1.03rem", lineHeight: 1.32 }}
          >
            &nbsp;
            {/* <img src="src\assets\Pathfinder2.png"  className='img-fluid' style={{ height: '4rem', width: 'auto' }} alt="" /> */}
            <b className="top-nav-brand-text">UPLB Physical Science Building Indoor Navigation</b>
          </MDBNavbarBrand>
          <div className="top-nav-actions">
            <a
              className="top-nav-manual-link"
              href="/user_manual.html"
              aria-label="User Manual"
              title="User Manual"
              onClick={(event) => {
                event.preventDefault();
                const manualWindow = window.open("/user_manual.html", "_blank");
                if (manualWindow) {
                  try {
                    manualWindow.opener = window;
                    manualWindow.focus();
                  } catch {
                    // Browser may restrict direct focus management here.
                  }
                }
              }}
            >
              <i className="fas fa-book-open" aria-hidden="true" />
            </a>
            {auth.loggedIn ? (
              <MDBBtn
                type="button"
                size="sm"
                className="top-nav-config-btn"
                onClick={() => {
                  window.location.hash = isConfiguratorPage ? "#/" : "#/configurator";
                }}
              >
                {isConfiguratorPage ? "Navigation Search" : "Layout Builder"}
              </MDBBtn>
            ) : null}
            {auth.loggedIn ? (
              <MDBBtn
                type="button"
                size="sm"
                className="top-nav-sandbox-btn"
                onClick={() => {
                  window.location.href = "/sandbox/#/configurator";
                }}
              >
                Sandbox
              </MDBBtn>
            ) : null}
            <MDBBtn
              type="button"
              size="sm"
              className="top-nav-login-btn"
              onClick={() => {
                if (auth.loggedIn) {
                  void logout();
                  return;
                }
                resetLoginValidationState();
                setLoginModalOpen(true);
              }}
            >
              {auth.loggedIn ? "Logout" : "Admin Login"}
            </MDBBtn>
          </div>

          {/* <MDBCollapse navbar>
          <MDBNavbarNav className="justify-content-center mb-2 mb-lg-0">
            <MDBNavbarItem>

            </MDBNavbarItem>
          </MDBNavbarNav>
        </MDBCollapse> */}

        </div>
      </MDBNavbar>
      {toast ? (
        <div
          className={`top-nav-toast ${toast.tone === "warning" ? "is-warning" : "is-success"}`}
          role="status"
          aria-live="polite"
        >
          <span className="top-nav-toast-dot" aria-hidden="true" />
          <span>{toast.message}</span>
        </div>
      ) : null}

      <MDBModal
        open={loginModalOpen}
        onClose={closeLoginModal}
        tabIndex={-1}
      >
        <MDBModalDialog centered className="top-nav-login-modal-dialog">
          <MDBModalContent className="top-nav-login-modal-content">
            <MDBModalHeader className="top-nav-login-modal-header">
              <MDBModalTitle className="top-nav-login-modal-title">
                Admin Login
              </MDBModalTitle>
            </MDBModalHeader>
            <MDBModalBody className="top-nav-login-modal-body">
              <form onSubmit={onLoginFormSubmit}>
                <div className="top-nav-login-modal-fields">
                  <MDBInput
                    label="Username"
                    type="text"
                    value={username}
                    onChange={(e) => {
                      if (loginError) resetLoginValidationState();
                      setUsername(e.target.value);
                    }}
                  />
                  <div className="top-nav-password-field">
                    <MDBInput
                      label="Password"
                      type={showLoginPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => {
                        if (loginError) resetLoginValidationState();
                        setPassword(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitLogin();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="top-nav-password-toggle"
                      aria-label={showLoginPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowLoginPassword((prev) => !prev)}
                    >
                      <i className={showLoginPassword ? "fas fa-eye-slash" : "fas fa-eye"} aria-hidden="true" />
                    </button>
                  </div>
                  {loginError ? (
                    <small style={{ color: "#b91c1c", fontWeight: 700 }}>
                      {loginError}
                    </small>
                  ) : null}
                  <button
                    type="button"
                    className="top-nav-change-password-link"
                    onClick={openChangePasswordModal}
                  >
                    Change Password
                  </button>
                </div>
              </form>
            </MDBModalBody>
            <MDBModalFooter className="top-nav-login-modal-footer top-nav-login-modal-footer-login">
              <MDBBtn
                color="secondary"
                className="top-nav-login-cancel-btn"
                onClick={closeLoginModal}
              >
                Cancel
              </MDBBtn>
              <MDBBtn
                className="top-nav-login-submit-btn"
                disabled={isSubmitting}
                onClick={() => {
                  void submitLogin();
                }}
              >
                {isSubmitting ? "Logging In..." : "Login"}
              </MDBBtn>
            </MDBModalFooter>
          </MDBModalContent>
        </MDBModalDialog>
      </MDBModal>

      <MDBModal
        open={changePasswordModalOpen}
        onClose={closeChangePasswordModal}
        tabIndex={-1}
        className="top-nav-change-password-modal"
      >
        <MDBModalDialog centered className="top-nav-login-modal-dialog">
          <MDBModalContent className="top-nav-login-modal-content">
            <MDBModalHeader className="top-nav-login-modal-header">
              <MDBModalTitle className="top-nav-login-modal-title">
                Change Password
              </MDBModalTitle>
            </MDBModalHeader>
            <MDBModalBody className="top-nav-login-modal-body">
              <form onSubmit={onChangePasswordFormSubmit}>
                <div className="top-nav-login-modal-fields">
                  <MDBInput
                    label="Username"
                    type="text"
                    value={changePasswordUsername}
                    onChange={(e) => setChangePasswordUsername(e.target.value)}
                  />
                  <div className="top-nav-password-field">
                    <MDBInput
                      label="Current Password"
                      type={showCurrentPassword ? "text" : "password"}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="top-nav-password-toggle"
                      tabIndex={-1}
                      aria-label={showCurrentPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowCurrentPassword((prev) => !prev)}
                    >
                      <i className={showCurrentPassword ? "fas fa-eye-slash" : "fas fa-eye"} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="top-nav-password-field">
                    <MDBInput
                      label="New Password"
                      type={showNewPassword ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="top-nav-password-toggle"
                      tabIndex={-1}
                      aria-label={showNewPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowNewPassword((prev) => !prev)}
                    >
                      <i className={showNewPassword ? "fas fa-eye-slash" : "fas fa-eye"} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="top-nav-password-field">
                    <MDBInput
                      label="Confirm New Password"
                      type={showConfirmNewPassword ? "text" : "password"}
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitChangePassword();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="top-nav-password-toggle"
                      tabIndex={-1}
                      aria-label={showConfirmNewPassword ? "Hide password" : "Show password"}
                      onClick={() => setShowConfirmNewPassword((prev) => !prev)}
                    >
                      <i className={showConfirmNewPassword ? "fas fa-eye-slash" : "fas fa-eye"} aria-hidden="true" />
                    </button>
                  </div>
                  {changePasswordError ? (
                    <small style={{ color: "#b91c1c", fontWeight: 700 }}>
                      {changePasswordError}
                    </small>
                  ) : null}
                </div>
              </form>
            </MDBModalBody>
            <MDBModalFooter className="top-nav-login-modal-footer">
              <MDBBtn
                color="secondary"
                className="top-nav-login-cancel-btn"
                onClick={closeChangePasswordModal}
              >
                Cancel
              </MDBBtn>
              <MDBBtn
                className="top-nav-login-submit-btn"
                disabled={isChangingPassword}
                onClick={() => {
                  void submitChangePassword();
                }}
              >
                {isChangingPassword ? "Updating..." : "Update Password"}
              </MDBBtn>
            </MDBModalFooter>
          </MDBModalContent>
        </MDBModalDialog>
      </MDBModal>
    </>
  );
}




