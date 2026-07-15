// The Bool end-user auth React layer. Wrap your app in <BoolAuthProvider>,
// gate screens with <AuthGate>, read state/actions with useBoolAuth(), and
// drive a login form with useSignInForm(). Only functional on a Bool with
// end-user auth available (every v2 app).
//
// Why the SDK ships this instead of letting each app implement it: the auth
// state machine (session subscription, initial load, error handling, the
// reset-token screen) is exactly what app code kept getting wrong. Providing
// it means each app gets identical, correct wiring and only differs in
// appearance — the form is restyled freely without any way to break sign-in.
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { getDefaultBoolClient, type BoolClient, type BoolUser } from "./client.js";

type AuthActionResult = { error: unknown };

export type BoolAuthState = {
  user: BoolUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<AuthActionResult>;
  signUp: (email: string, password: string) => Promise<AuthActionResult>;
  signInWithGoogle: () => { data: unknown; error: unknown };
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  confirmReset: (token: string, password: string) => Promise<AuthActionResult>;
};

const BoolAuthContext = createContext<BoolAuthState | null>(null);

export function BoolAuthProvider({
  children,
  client,
}: {
  children: ReactNode;
  /** Defaults to the client created by createBoolClient() — in a Bool app
   * that's the one from src/lib/supabase.ts, so you never pass this. */
  client?: BoolClient;
}) {
  const bool = client ?? getDefaultBoolClient();
  const [user, setUser] = useState<BoolUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fires once with the current session (or null), then on every sign in/out.
    const { data } = bool.auth.onAuthStateChange(
      (_event: string, nextUser: BoolUser | null) => {
        setUser(nextUser);
        setLoading(false);
      },
    );
    return () => data.subscription.unsubscribe();
  }, [bool]);

  const value: BoolAuthState = {
    user,
    loading,
    async signIn(email, password) {
      const { data, error } = await bool.auth.signInWithPassword({ email, password });
      if (data.user) setUser(data.user);
      return { error };
    },
    async signUp(email, password) {
      const { data, error } = await bool.auth.signUp({ email, password });
      if (data.user) setUser(data.user);
      return { error };
    },
    signInWithGoogle() {
      return bool.auth.signInWithOAuth({ provider: "google" });
    },
    async signOut() {
      await bool.auth.signOut();
      setUser(null);
    },
    async resetPassword(email) {
      await bool.auth.resetPasswordForEmail(email);
    },
    async confirmReset(token, password) {
      const { data, error } = await bool.auth.confirmPasswordReset({ token, password });
      if (data.user) setUser(data.user);
      return { error };
    },
  };

  return <BoolAuthContext.Provider value={value}>{children}</BoolAuthContext.Provider>;
}

export function useBoolAuth(): BoolAuthState {
  const ctx = useContext(BoolAuthContext);
  if (!ctx) throw new Error("useBoolAuth must be used inside <BoolAuthProvider>");
  return ctx;
}

// Renders `children` for a signed-in user, otherwise `fallback` (your login
// screen). Renders nothing while the initial session check is in flight.
export function AuthGate({
  children,
  fallback,
}: {
  children: ReactNode;
  fallback: ReactNode;
}) {
  const { user, loading } = useBoolAuth();
  if (loading) return null;
  return <>{user ? children : fallback}</>;
}

export type SignInMode = "signin" | "signup" | "reset" | "newPassword";

// Headless sign-in behavior. This owns the ENTIRE login state machine and every
// auth call (sign in / sign up / reset / confirm / Google) so a restyled form
// can never break it: your form just reads these values and wires the returned
// handlers to your own markup. You never call signIn/signUp/etc. yourself.
//   const f = useSignInForm();
//   <form onSubmit={f.submit}> …inputs bound to f.email/f.password… </form>
//   <button onClick={f.signInWithGoogle}>Continue with Google</button>
//   <button onClick={() => f.setMode("signup")}>Create an account</button>
export function useSignInForm() {
  const { signIn, signUp, signInWithGoogle, resetPassword, confirmReset } = useBoolAuth();
  const [mode, setMode] = useState<SignInMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A reset email links back here with ?bool_reset_token=… — switch to the
  // "set a new password" mode when that's present.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("bool_reset_token");
    if (token) {
      setResetToken(token);
      setMode("newPassword");
    }
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error } = await signIn(email, password);
        if (error) setMessage("Wrong email or password.");
      } else if (mode === "signup") {
        const { error } = await signUp(email, password);
        if (error) setMessage("Could not create that account — try a different email.");
      } else if (mode === "reset") {
        await resetPassword(email);
        setMessage("If that email has an account, a reset link is on its way.");
      } else if (mode === "newPassword" && resetToken) {
        const { error } = await confirmReset(resetToken, password);
        if (error) setMessage("That reset link is invalid or has expired.");
      }
    } finally {
      setBusy(false);
    }
  }

  // Google sign-in is fire-and-start (a popup or a redirect). In the editor
  // preview a blocked popup can't complete — surface that as the form message
  // instead of silently doing nothing, so the user knows to allow pop-ups or
  // use email. On success there's no synchronous error; the auth state updates
  // when the token lands.
  function startGoogleSignIn() {
    setMessage(null);
    const { error } = signInWithGoogle();
    if (error) {
      const m = (error as { message?: string }).message;
      setMessage(m || "Couldn't start Google sign-in here — try email + password.");
    }
  }

  return {
    mode,
    setMode,
    email,
    setEmail,
    password,
    setPassword,
    message,
    busy,
    submit,
    signInWithGoogle: startGoogleSignIn,
  };
}
