import * as signalR from "@microsoft/signalr";
import { apiBaseUrl } from "./api";

const connection = new signalR.HubConnectionBuilder()
    .withUrl(`${apiBaseUrl}/chatHub`, {
        accessTokenFactory: () => {
            return sessionStorage.getItem("token") || "";
        }
    })
    .withAutomaticReconnect()
    .build();

export default connection;
