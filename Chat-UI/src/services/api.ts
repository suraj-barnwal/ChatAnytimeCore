import axios from "axios";

// Production serves the UI and API from one origin through the web proxy.
// Keep local development pointed at the API's http launch profile.
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.PROD ? "" : "http://localhost:5290");

const api = axios.create({
    baseURL: apiBaseUrl
});

export default api;
