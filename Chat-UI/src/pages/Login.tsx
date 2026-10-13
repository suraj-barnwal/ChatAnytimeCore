import { useState } from "react";
import type { FormEvent } from "react";
import axios from "axios";
import api from "../services/api";

function Login({ onLogin }: { onLogin: () => void }) {

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [errorMessage, setErrorMessage] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    const login = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setErrorMessage("");
        if (!email.trim() || !password) {
            setErrorMessage("Enter your email and password to continue.");
            return;
        }

        setIsLoading(true);
        try{
            const response = await api.post("/Login",
                {
                    email,
                    password
                });
            const data = response.data as {
                token?: string; Token?: string;
                userId?: number | string; UserId?: number | string;
                name?: string; Name?: string;
                email?: string; Email?: string;
                isAdmin?: boolean; IsAdmin?: boolean;
            };
            const token = data.token ?? data.Token;
            const userId = data.userId ?? data.UserId;
            const accountName = data.name ?? data.Name ?? data.email ?? data.Email;
            if (!token || userId === undefined || !accountName) {
                throw new Error("The API login response did not include the user name and ID.");
            }

            sessionStorage.setItem("token", token);
            sessionStorage.setItem("userId", String(userId));
            sessionStorage.setItem("userName", accountName);
            sessionStorage.setItem("isAdmin", String(data.isAdmin ?? data.IsAdmin ?? false));

            onLogin();
        }
        catch(error: unknown){
            console.log(error);
            if (axios.isAxiosError(error)) {
                if (!error.response) {
                    setErrorMessage("Cannot reach the API. Check that it is running.");
                } else if (error.response.status === 401) {
                    setErrorMessage("Invalid email or password.");
                } else if (typeof error.response.data === "string") {
                    setErrorMessage(error.response.data);
                } else {
                    setErrorMessage("The API could not complete the login. Check the API logs.");
                }
            } else if (error instanceof Error) {
                setErrorMessage(error.message);
            } else {
                setErrorMessage("Login failed. Please try again.");
            }
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <main className="auth-shell">
            <section className="auth-art" aria-label="Chat Anytime introduction">
                <div className="brand"><span className="brand-mark">✦</span> Chat Anytime</div>
                <div className="auth-copy">
                    <h1>Make room<br />for better<br /><em>conversations.</em></h1>
                    <p>A calm place for the people and ideas you want close.</p>
                </div>
                <div className="auth-note">Private by design · Always in the moment</div>
            </section>
            <section className="auth-panel">
                <form className="auth-form" onSubmit={login}>
                    <p className="eyebrow">Welcome back</p>
                    <h2>Sign in</h2>
                    <p className="form-intro">Pick up the conversation right where you left it.</p>
                    {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
                    <div className="field">
                        <label htmlFor="email">Email address</label>
                        <input id="email" type="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" />
                    </div>
                    <div className="field">
                        <label htmlFor="password">Password</label>
                        <input id="password" type="password" placeholder="Your password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
                    </div>
                    <button className="primary-button" type="submit" disabled={isLoading}>{isLoading ? "Signing in..." : "Continue to chat"}</button>
                </form>
            </section>
        </main>
    );
}
export default Login;
