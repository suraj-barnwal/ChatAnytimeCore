import { useEffect, useState } from "react";
import Login from './pages/Login.tsx';
import Chat from "./pages/Chat.tsx";
import api from "./services/api";
import "./styles.css";

function tokenHasAdminRole(): boolean {
    try {
        const token = sessionStorage.getItem("token");
        if (!token) return false;
        const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))) as Record<string, unknown>;
        const roleClaim = claims.role ?? claims.roles ?? claims["http://schemas.microsoft.com/ws/2008/06/identity/claims/role"];
        return Array.isArray(roleClaim) ? roleClaim.includes("Admin") : roleClaim === "Admin";
    } catch {
        return false;
    }
}

function UnavailablePage({ onSignInAsAdmin }: { onSignInAsAdmin: () => void }) {
    return <main className="unavailable-page"><div><p className="unavailable-icon">:(</p><h1>This site can’t be reached</h1><p>Chat Anytime is currently unavailable. Please try again later.</p><button type="button" className="admin-signin-button" onClick={onSignInAsAdmin}>Sign in as Stark admin</button></div></main>;
}

function App() {
    const [isLoggedIn, setIsLoggedIn] = useState(!!sessionStorage.getItem("token"));
    const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
    const isAdmin = sessionStorage.getItem("isAdmin") === "true" || tokenHasAdminRole();

    useEffect(() => {
        let mounted = true;
        const refreshAvailability = async () => {
            try {
                const response = await api.get<{ isAvailable: boolean }>("/System/Status");
                if (mounted) setIsAvailable(response.data.isAvailable);
            } catch {
                if (mounted) setIsAvailable(false);
            }
        };
        void refreshAvailability();
        const timer = window.setInterval(refreshAvailability, 2500);
        return () => {
            mounted = false;
            window.clearInterval(timer);
        };
    }, []);

    if (isAvailable === null) return <main className="availability-check">Checking Chat Anytime availability…</main>;
    // Keep the login form reachable during an outage so Stark can authenticate
    // and restore service. Non-admin users see the unavailable screen after login.
    if (!isAvailable && isLoggedIn && !isAdmin) {
        return <UnavailablePage onSignInAsAdmin={() => {
            sessionStorage.removeItem("token");
            sessionStorage.removeItem("userId");
            sessionStorage.removeItem("userName");
            sessionStorage.removeItem("isAdmin");
            setIsLoggedIn(false);
        }} />;
    }
    if (isLoggedIn) return <Chat isAvailable={isAvailable} onLogout={() => setIsLoggedIn(false)} onAvailabilityChange={setIsAvailable} />;
    return <Login onLogin={() => setIsLoggedIn(true)} />;
}

export default App;
