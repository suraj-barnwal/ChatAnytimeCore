import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import connection from "../services/signalr";
import api from "../services/api";
import { attachmentSizeLabel, compressAttachment, isImageOrVideoAttachment } from "../services/mediaCompression";

type ChatUser = { userId: number; name: string; lastMessageText: string; lastMessageTime?: string; lastMessageContentType?: string; unreadCount: number };
type ApiUser = { userId?: number; UserId?: number; name?: string; Name?: string; isAdmin?: boolean; IsAdmin?: boolean; lastMessageText?: string | null; LastMessageText?: string | null; lastMessageTime?: string | null; LastMessageTime?: string | null; lastMessageContentType?: string | null; LastMessageContentType?: string | null; unreadCount?: number; UnreadCount?: number };

type ChatMessage = {
    id: number;
    text: string;
    direction: "incoming" | "outgoing";
    time: string;
    queued?: boolean;
    status?: "sent" | "received" | "seen";
    mediaContentType?: string;
    mediaFileName?: string;
    mediaFileSizeBytes?: number;
};
type ClearScope = "me" | "everyone" | "other";

type ApiMessage = { id: number; senderId: number; text: string; sentTime: string; isDelivered: boolean; isRead: boolean; mediaContentType?: string | null; mediaFileName?: string | null };

// SQL Server stores DateTime without an offset. The API's message contract treats
// stored timestamps as UTC, so make that explicit before browser-local formatting.
function formatMessageTime(value: string | Date): string {
    const timestamp = value instanceof Date ? value : new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
    if (Number.isNaN(timestamp.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h12" }).format(timestamp);
}

function formatPreviewTime(value?: string): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const today = new Date();
    return date.toDateString() === today.toDateString()
        ? formatMessageTime(date)
        : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

const frequentEmojis = ["😀", "😃", "😄", "😁", "😆", "😂", "🙂", "😉", "😊", "😍", "🥰", "😘", "😭", "😢", "😞", "😔", "🥺", "😣", "😎", "🤔", "😠", "😡", "🤬", "😤", "🙄", "🙏", "👍", "👎", "👏", "🎉", "❤️", "🔥", "🤗", "🤦", "🤷", "💪", "💯", "🫶", "😱", "🤯"];

function MessageMedia({ messageId, contentType, fileName, onSize }: { messageId: number; contentType: string; fileName?: string; onSize: (messageId: number, size: number) => void }) {
    const [source, setSource] = useState("");
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let objectUrl = "";
        let cancelled = false;
        api.get(`/Messages/Media/${messageId}`, {
            responseType: "blob",
            headers: { Authorization: `Bearer ${sessionStorage.getItem("token")}` }
        }).then((response) => {
            if (cancelled) return;
            objectUrl = URL.createObjectURL(response.data);
            setSource(objectUrl);
            onSize(messageId, response.data.size);
        }).catch(() => { if (!cancelled) setFailed(true); });
        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [messageId, onSize]);

    if (failed) return <span className="media-unavailable">Media unavailable</span>;
    if (!source) return <span className="media-loading">Loading media…</span>;
    if (contentType.startsWith("video/")) return <video className="message-media" src={source} controls preload="metadata" />;
    if (contentType.startsWith("image/")) return <img className="message-media" src={source} alt={fileName || "Shared image"} loading="lazy" />;
    return <a className="message-attachment" href={source} download={fileName || "download"}>
        <span aria-hidden="true">📎</span><span>{fileName || "Download attachment"}</span>
    </a>;
}

function statusRank(status: NonNullable<ChatMessage["status"]>): number {
    return status === "seen" ? 2 : status === "received" ? 1 : 0;
}

function getTokenClaims(): Record<string, unknown> | undefined {
    try {
        const token = sessionStorage.getItem("token");
        if (!token) return undefined;
        const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))) as Record<string, unknown>;
    } catch {
        return undefined;
    }
}

function getNameFromToken(): string | undefined {
    const payload = getTokenClaims();
    if (payload) {
        const name = payload.name ?? payload.unique_name ?? payload["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];
        return typeof name === "string" && name.trim() ? name : undefined;
    }
    return undefined;
}

function getUserIdFromToken(): number | undefined {
    const payload = getTokenClaims();
    const claim = payload?.nameid ?? payload?.sub ?? payload?.["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier"];
    const userId = Number(claim);
    return Number.isInteger(userId) && userId > 0 ? userId : undefined;
}

function Chat({ isAvailable, onLogout, onAvailabilityChange }: { isAvailable: boolean; onLogout: () => void; onAvailabilityChange: (available: boolean) => void }) {
    const [isSidebarOpen, setIsSidebarOpen] = useState(() => window.matchMedia("(min-width: 761px)").matches);
    const savedName = sessionStorage.getItem("userName");
    const [userName, setUserName] = useState(savedName && savedName !== "You" && savedName !== "undefined" ? savedName : "Loading profile...");
    const [message, setMessage] = useState("");
    const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
    const [isUploadingMedia, setIsUploadingMedia] = useState(false);
    const [pendingMedia, setPendingMedia] = useState<File | null>(null);
    const [mediaUploadProgress, setMediaUploadProgress] = useState(0);
    const [isCompressingMedia, setIsCompressingMedia] = useState(false);
    const [mediaCompressionStatus, setMediaCompressionStatus] = useState("");
    const [mediaCompressionError, setMediaCompressionError] = useState("");
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isConnected, setIsConnected] = useState(false);
    const [users, setUsers] = useState<ChatUser[]>([]);
    const [isLoadingUsers, setIsLoadingUsers] = useState(true);
    const [userListError, setUserListError] = useState("");
    const [receiverId, setReceiverId] = useState<number | null>(null);
    const [loadError, setLoadError] = useState("");
    const [onlineUserIds, setOnlineUserIds] = useState<number[]>([]);
    const [sendError, setSendError] = useState("");
    const [isAdmin, setIsAdmin] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [clearScope, setClearScope] = useState<ClearScope | null>(null);
    const [clearTarget, setClearTarget] = useState<"conversation" | "selected">("conversation");
    const [clearError, setClearError] = useState("");
    const [isClearingChat, setIsClearingChat] = useState(false);
    const [isSelectingMessages, setIsSelectingMessages] = useState(false);
    const [selectedMessageIds, setSelectedMessageIds] = useState<number[]>([]);
    const [availabilityDialogOpen, setAvailabilityDialogOpen] = useState(false);
    const [isChangingAvailability, setIsChangingAvailability] = useState(false);
    const selectedReceiverId = useRef<number | null>(receiverId);
    const usersRefreshVersion = useRef(0);
    const statusUpdates = useRef(new Map<number, ChatMessage["status"]>());
    const messageAreaRef = useRef<HTMLDivElement | null>(null);
    const mediaInputRef = useRef<HTMLInputElement | null>(null);
    const emojiControlRef = useRef<HTMLDivElement | null>(null);
    selectedReceiverId.current = receiverId;

    const pendingMediaPreview = useMemo(() => pendingMedia ? URL.createObjectURL(pendingMedia) : "", [pendingMedia]);
    useEffect(() => () => { if (pendingMediaPreview) URL.revokeObjectURL(pendingMediaPreview); }, [pendingMediaPreview]);
    const updateMediaFileSize = useCallback((messageId: number, size: number) => {
        setMessages((previous) => previous.map((item) => item.id === messageId && item.mediaFileSizeBytes !== size
            ? { ...item, mediaFileSizeBytes: size }
            : item));
    }, []);

    const refreshUsers = async () => {
        const requestVersion = ++usersRefreshVersion.current;
        try {
            const token = sessionStorage.getItem("token");
            const currentUserId = getUserIdFromToken() || Number(sessionStorage.getItem("userId")) || 0;
            const response = await api.get<ApiUser[]>("/Users", { headers: { Authorization: `Bearer ${token}` } });
            const normalizedUsers = response.data
                .map((user) => ({
                    userId: Number(user.userId ?? user.UserId),
                    name: user.name ?? user.Name ?? "",
                    lastMessageText: user.lastMessageText ?? user.LastMessageText ?? "",
                    lastMessageTime: user.lastMessageTime ?? user.LastMessageTime ?? undefined,
                    lastMessageContentType: user.lastMessageContentType ?? user.LastMessageContentType ?? undefined,
                    unreadCount: Number(user.unreadCount ?? user.UnreadCount ?? 0)
                }))
                .filter((user) => Number.isInteger(user.userId) && user.userId !== currentUserId && user.name.length > 0)
                .sort((left, right) => (right.lastMessageTime ? new Date(right.lastMessageTime).getTime() : 0) - (left.lastMessageTime ? new Date(left.lastMessageTime).getTime() : 0) || left.name.localeCompare(right.name));
            // A slower response must not replace more recent unread counts.
            if (requestVersion === usersRefreshVersion.current) {
                setUsers(normalizedUsers);
                setUserListError("");
                setIsLoadingUsers(false);
            }
        } catch (error) {
            if (requestVersion === usersRefreshVersion.current) {
                setUserListError("Could not load users from the API. Check that it is running, then retry.");
                setIsLoadingUsers(false);
            }
            throw error;
        }
    };

    useEffect(() => {
        const messageArea = messageAreaRef.current;
        if (messageArea) messageArea.scrollTo({ top: messageArea.scrollHeight, behavior: "smooth" });
    }, [messages.length, receiverId]);

    useEffect(() => {
        if (!emojiPickerOpen) return;
        const closeOnOutsideClick = (event: PointerEvent) => {
            if (event.target instanceof Node && !emojiControlRef.current?.contains(event.target)) setEmojiPickerOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") setEmojiPickerOpen(false);
        };
        document.addEventListener("pointerdown", closeOnOutsideClick);
        document.addEventListener("keydown", closeOnEscape);
        return () => {
            document.removeEventListener("pointerdown", closeOnOutsideClick);
            document.removeEventListener("keydown", closeOnEscape);
        };
    }, [emojiPickerOpen]);

    useEffect(() => {
        const startConnection = async () => {
            const token = sessionStorage.getItem("token");
            const headers = { Authorization: `Bearer ${token}` };
            try {
                const currentUserId = getUserIdFromToken() || Number(sessionStorage.getItem("userId")) || 0;
                if (currentUserId) sessionStorage.setItem("userId", String(currentUserId));
                await refreshUsers();
            } catch (error) {
                console.error("Could not load chat users:", error);
                setLoadError("Could not load chat users. Please sign in again and retry.");
            }

            let accountName = sessionStorage.getItem("userName") || getNameFromToken();
            try {
                const meResponse = await api.get<ApiUser>("/Me", { headers });
                accountName = meResponse.data.name ?? meResponse.data.Name ?? accountName;
                const adminAccess = meResponse.data.isAdmin ?? meResponse.data.IsAdmin ?? false;
                setIsAdmin(adminAccess);
                sessionStorage.setItem("isAdmin", String(adminAccess));
            } catch (error) {
                console.warn("Could not load profile from API; using the login name or token claim.", error);
            }
            accountName = accountName?.trim() || getNameFromToken() || "Signed-in user";
            setUserName(accountName);
            sessionStorage.setItem("userName", accountName);

            try {
                if (connection.state === "Disconnected") await connection.start();
                setIsConnected(true);
            } catch (error) {
                console.error("SignalR Connection Error:", error);
                setLoadError("Could not connect to chat. Check that the API is running.");
                setIsConnected(false);
            }
        };

        const receiveMessage = (id: number, senderId: number, _receiverId: number, receivedMessage: string, sentTime: string, mediaContentType?: string, mediaFileName?: string) => {
            const currentUserId = Number(sessionStorage.getItem("userId"));
            const isCurrentConversation = selectedReceiverId.current === Number(senderId);
            const isVisibleToUser = document.visibilityState === "visible" && document.hasFocus();
            if (isCurrentConversation) {
                setMessages((previous) => previous.some((item) => item.id === id) ? previous : [...previous, {
                    id,
                    text: receivedMessage,
                    direction: senderId === currentUserId ? "outgoing" : "incoming",
                    time: formatMessageTime(sentTime),
                    mediaContentType,
                    mediaFileName
                }]);
            }
            if (!isCurrentConversation || !isVisibleToUser) {
                setUsers((previous) => previous.map((user) => user.userId === senderId
                    ? { ...user, unreadCount: user.unreadCount + 1, lastMessageText: receivedMessage || user.lastMessageText, lastMessageTime: sentTime, lastMessageContentType: mediaContentType ?? user.lastMessageContentType }
                    : user).sort((left, right) => (right.lastMessageTime ? new Date(right.lastMessageTime).getTime() : 0) - (left.lastMessageTime ? new Date(left.lastMessageTime).getTime() : 0) || left.name.localeCompare(right.name)));
            }
            connection.invoke("AcknowledgeMessage", id, isCurrentConversation && isVisibleToUser)
                .then(() => refreshUsers())
                .catch((error: unknown) => console.error("Could not acknowledge message:", error));
        };

        const updateMessageStatus = (id: number, status: ChatMessage["status"]) => {
            statusUpdates.current.set(id, status);
            setMessages((previous) => previous.map((item) => item.id === id ? { ...item, status } : item));
        };

        const updateOnlineUsers = (ids: string[]) => setOnlineUserIds(ids.map(Number));
        const conversationDeleted = (adminId: number) => {
            if (selectedReceiverId.current === Number(adminId)) {
                setMessages([]);
                void refreshUsers().catch((error: unknown) => console.error("Could not refresh conversation notifications:", error));
            }
        };
        const selectedMessagesDeleted = (actorId: number, messageIds: number[]) => {
            if (selectedReceiverId.current !== Number(actorId)) return;
            const deletedIds = new Set(messageIds.map(Number));
            setMessages((previous) => previous.filter((item) => !deletedIds.has(item.id)));
            void refreshUsers().catch((error: unknown) => console.error("Could not refresh conversation notifications:", error));
        };
        connection.on("OnlineUsers", updateOnlineUsers);
        connection.on("ReceiveMessage", receiveMessage);
        connection.on("MessageStatusUpdated", updateMessageStatus);
        connection.on("ConversationDeleted", conversationDeleted);
        connection.on("MessagesDeleted", selectedMessagesDeleted);
        startConnection();

        return () => {
            connection.off("OnlineUsers", updateOnlineUsers);
            connection.off("ReceiveMessage", receiveMessage);
            connection.off("MessageStatusUpdated", updateMessageStatus);
            connection.off("ConversationDeleted", conversationDeleted);
            connection.off("MessagesDeleted", selectedMessagesDeleted);
        };
    }, []);

    useEffect(() => {
        if (!isConnected || receiverId === null) return;
        const token = sessionStorage.getItem("token");
        api.get<ApiMessage[]>(`/Messages/${receiverId}`, {
            headers: { Authorization: `Bearer ${token}` }
        }).then((response) => {
            const currentUserId = Number(sessionStorage.getItem("userId"));
            const loadedMessages: ChatMessage[] = response.data.map((item) => ({
                id: item.id,
                text: item.text,
                direction: item.senderId === currentUserId ? "outgoing" : "incoming",
                time: formatMessageTime(item.sentTime),
                status: item.isRead ? "seen" : item.isDelivered ? "received" : "sent",
                mediaContentType: item.mediaContentType ?? undefined,
                mediaFileName: item.mediaFileName ?? undefined
            }));
            void refreshUsers().catch((error: unknown) => console.error("Could not refresh conversation notifications:", error));
            setMessages((previous) => {
                const byId = new Map<number, ChatMessage>(loadedMessages.map((item): [number, ChatMessage] => [item.id, item]));
                previous.forEach((item) => {
                    const loaded = byId.get(item.id);
                    if (!loaded || (item.status && statusRank(item.status) > statusRank(loaded.status ?? "sent"))) byId.set(item.id, item);
                });
                return [...byId.values()].sort((a, b) => a.id - b.id);
            });
        }).catch((error: unknown) => {
            console.error("Could not load conversation:", error);
            setLoadError("Could not load the conversation history.");
        });
    }, [isConnected, receiverId]);

    useEffect(() => {
        if (!isConnected || receiverId === null) return;
        const markOpenConversationRead = () => {
            if (document.visibilityState !== "visible" || !document.hasFocus()) return;
            const token = sessionStorage.getItem("token");
            api.get(`/Messages/${receiverId}`, { headers: { Authorization: `Bearer ${token}` } })
                .then(() => refreshUsers())
                .catch((error: unknown) => console.error("Could not mark conversation as read:", error));
        };
        document.addEventListener("visibilitychange", markOpenConversationRead);
        window.addEventListener("focus", markOpenConversationRead);
        return () => {
            document.removeEventListener("visibilitychange", markOpenConversationRead);
            window.removeEventListener("focus", markOpenConversationRead);
        };
    }, [isConnected, receiverId]);

    const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmedMessage = message.trim();
        if (!trimmedMessage || receiverId === null || connection.state !== "Connected") return;
        const currentUserId = getUserIdFromToken() || Number(sessionStorage.getItem("userId"));
        if (receiverId === currentUserId) {
            setSendError("Choose another user to send a message.");
            return;
        }

        try {
            setSendError("");
            const result = await connection.invoke<{ messageId: number; queued: boolean; error?: string }>("SendMessage", receiverId, trimmedMessage);
            if (result.error || result.messageId < 1) {
                setSendError(result.error || "Message could not be sent.");
                return;
            }
            setMessages((previous) => [...previous, {
                id: result.messageId,
                text: trimmedMessage,
                direction: "outgoing",
                time: formatMessageTime(new Date()),
                queued: result.queued,
                status: statusUpdates.current.get(result.messageId) ?? "sent"
            }]);
            setMessage("");
            void refreshUsers().catch((error: unknown) => console.error("Could not refresh conversation notifications:", error));
        } catch (error) {
            console.error("Send Message Error:", error);
            setSendError("Message could not be sent. Please try again.");
        }
    };

    const logout = () => {
        sessionStorage.removeItem("token");
        sessionStorage.removeItem("userId");
        sessionStorage.removeItem("userName");
        sessionStorage.removeItem("isAdmin");
        connection.stop();
        onLogout();
    };

    const selectMedia = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || receiverId === null || isCompressingMedia) return;
        const isCompressibleMedia = isImageOrVideoAttachment(file);
        if (!isCompressibleMedia && file.size > 20 * 1024 * 1024) {
            setSendError("Files must be 20 MB or smaller.");
            return;
        }
        setSendError("");
        setMediaCompressionError("");
        setPendingMedia(file);
        if (!isCompressibleMedia) return;
        setIsCompressingMedia(true);
        setMediaCompressionStatus(file.type.startsWith("video/") ? "Compressing video…" : "Compressing image…");
        try {
            const compressedFile = await compressAttachment(file, setMediaCompressionStatus);
            setPendingMedia(compressedFile);
        } catch (error) {
            const compressionError = error instanceof Error ? error.message : "Could not compress this attachment.";
            setMediaCompressionError(compressionError);
        } finally {
            setIsCompressingMedia(false);
            setMediaCompressionStatus("");
        }
    };

    const sendMedia = async () => {
        const file = pendingMedia;
        if (!file || receiverId === null || isUploadingMedia || isCompressingMedia || mediaCompressionError) return;

        const formData = new FormData();
        formData.append("receiverId", String(receiverId));
        formData.append("text", message.trim());
        formData.append("file", file);
        try {
            setIsUploadingMedia(true);
            setSendError("");
            const response = await api.post<ApiMessage & { receiverId: number; queued: boolean }>("/Messages/Media", formData, {
                headers: { Authorization: `Bearer ${sessionStorage.getItem("token")}` },
                onUploadProgress: (event) => {
                    if (event.total) setMediaUploadProgress(Math.round((event.loaded / event.total) * 100));
                }
            });
            const uploaded = response.data;
            setMessages((previous) => [...previous, {
                id: uploaded.id,
                text: uploaded.text,
                direction: "outgoing",
                time: formatMessageTime(uploaded.sentTime),
                queued: uploaded.queued,
                status: "sent",
                mediaContentType: uploaded.mediaContentType ?? undefined,
                mediaFileName: uploaded.mediaFileName ?? file.name,
                mediaFileSizeBytes: file.size
            }]);
            setMessage("");
            setPendingMedia(null);
            setMediaCompressionError("");
            setMediaUploadProgress(0);
            void refreshUsers().catch((error: unknown) => console.error("Could not refresh conversation notifications:", error));
        } catch (error) {
            console.error("Could not send media:", error);
            const errorData = (error as { response?: { data?: unknown } })?.response?.data;
            const responseMessage = typeof errorData === "string"
                ? errorData
                : errorData && typeof errorData === "object" && "message" in errorData && typeof errorData.message === "string"
                    ? errorData.message
                    : errorData && typeof errorData === "object" && "title" in errorData && typeof errorData.title === "string"
                        ? errorData.title
                        : "Could not send the file. Check that the API is running and try again.";
            setSendError(responseMessage);
        } finally {
            setIsUploadingMedia(false);
            setMediaUploadProgress(0);
        }
    };

    const deleteConversation = async () => {
        if (receiverId === null || clearScope === null || isClearingChat || (!isAdmin && clearScope !== "me")) return;
        try {
            setIsClearingChat(true);
            const headers = { Authorization: `Bearer ${sessionStorage.getItem("token")}` };
            if (clearTarget === "selected") {
                await api.delete("/Messages/Selected", { data: { messageIds: selectedMessageIds, scope: clearScope }, headers });
                const deletedIds = new Set(selectedMessageIds);
                setMessages((previous) => previous.filter((item) => !deletedIds.has(item.id)));
                setSelectedMessageIds([]);
                setIsSelectingMessages(false);
            } else {
                await api.delete(`/Messages/${receiverId}?scope=${clearScope}`, { headers });
                setMessages([]);
            }
            setDeleteDialogOpen(false);
            setClearScope(null);
            setClearError("");
            setSendError("");
            void refreshUsers().catch((error: unknown) => console.error("Could not refresh conversation notifications:", error));
        } catch (error) {
            console.error("Could not delete conversation messages:", error);
            setClearError("Could not clear this chat. Please try again.");
        } finally {
            setIsClearingChat(false);
        }
    };

    const toggleMessageSelection = (messageId: number, selected: boolean) => {
        setSelectedMessageIds((current) => selected
            ? current.includes(messageId) ? current : [...current, messageId]
            : current.filter((id) => id !== messageId));
    };

    const openSelectedMessagesDelete = () => {
        if (!selectedMessageIds.length) return;
        setClearTarget("selected");
        setClearScope(null);
        setClearError("");
        setDeleteDialogOpen(true);
    };

    const toggleApplicationAvailability = async () => {
        if (!isAdmin || isChangingAvailability) return;
        const nextAvailability = !isAvailable;
        try {
            setIsChangingAvailability(true);
            const response = await api.post<{ isAvailable: boolean }>("/System/Availability", { isAvailable: nextAvailability }, {
                headers: { Authorization: `Bearer ${sessionStorage.getItem("token")}` }
            });
            onAvailabilityChange(response.data.isAvailable);
            setAvailabilityDialogOpen(false);
        } catch (error) {
            console.error("Could not change application availability:", error);
            setSendError("Could not change application availability. Please try again.");
        } finally {
            setIsChangingAvailability(false);
        }
    };

    const initials = userName.slice(0, 1).toUpperCase();
    const receiver = users.find((user) => user.userId === receiverId);
    const receiverIsOnline = receiverId !== null && onlineUserIds.includes(receiverId);
    const closeSidebarAfterSelection = () => {
        if (window.matchMedia("(max-width: 760px)").matches) setIsSidebarOpen(false);
    };

    return (
        <main className={`chat-shell ${isSidebarOpen ? "sidebar-open" : "sidebar-hidden"}`}>
            {isSidebarOpen && <button className="sidebar-backdrop" type="button" aria-label="Close conversations menu" onClick={() => setIsSidebarOpen(false)} />}
            <aside className="sidebar">
                <div className="brand"><span className="brand-mark">✦</span> Chat Anytime{isAdmin && <button className={`availability-toggle ${isAvailable ? "is-live" : "is-offline"}`} type="button" title={isAvailable ? "Turn application off" : "Turn application on"} aria-label={isAvailable ? "Turn application off" : "Turn application on"} onClick={() => setAvailabilityDialogOpen(true)}>⏻</button>}</div>
                <div className="profile">
                    <span className="avatar">{initials}</span>
                    <div className="profile-name"><strong>{userName}</strong><i className={`presence-dot ${isConnected ? "online" : "offline"}`} role="img" aria-label={isConnected ? "Online" : "Offline"} title={isConnected ? "Online" : "Offline"} /></div>
                </div>
                <p className="sidebar-label">Your conversations</p>
                {users.map((user) => {
                    const online = onlineUserIds.includes(user.userId);
                    const preview = user.lastMessageContentType
                        ? `${user.lastMessageContentType.startsWith("video/") ? "Video" : user.lastMessageContentType.startsWith("image/") ? "Photo" : "File"}${user.lastMessageText ? ` · ${user.lastMessageText}` : ""}`
                        : user.lastMessageText || "Start a new thought";
                    return <button className={`chat-preview ${receiverId === user.userId ? "active" : ""}`} type="button" key={user.userId} onClick={() => { setReceiverId(user.userId); setUsers((current) => current.map((item) => item.userId === user.userId ? { ...item, unreadCount: 0 } : item)); setMessages([]); setSelectedMessageIds([]); setIsSelectingMessages(false); closeSidebarAfterSelection(); }}>
                        <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
                        <div className="chat-preview-copy">
                            <strong>{user.name}<i className={`presence-dot ${online ? "online" : "offline"}`} aria-label={online ? "Online" : "Offline"} title={online ? "Online" : "Offline"} /></strong>
                            <small className="chat-preview-subline"><span>{preview}</span><time>{formatPreviewTime(user.lastMessageTime)}</time></small>
                        </div>
                        {user.unreadCount > 0 && <span className="unread-badge" aria-label={`${user.unreadCount} unread messages`}>{user.unreadCount > 99 ? "99+" : user.unreadCount}</span>}
                    </button>;
                })}
                {userListError && <div className="sidebar-list-error"><span>{userListError}</span><button type="button" onClick={() => { setUserListError(""); setIsLoadingUsers(true); void refreshUsers().catch((error: unknown) => console.error("Could not reload users:", error)); }}>Retry</button></div>}
                {!userListError && isLoadingUsers && <p className="sidebar-list-state">Loading users…</p>}
                {!userListError && !isLoadingUsers && !users.length && <p className="sidebar-list-state">No other users yet</p>}
                <div className="sidebar-footer">
                    <div className="connection"><span className={`status-dot ${isConnected ? "connected" : ""}`} />{userName}</div>
                    <button className="logout-button" type="button" onClick={logout}>Sign out</button>
                </div>
            </aside>

            <section className="chat-main">
                <header className="chat-header">
                    <div className="chat-header-start">
                        <button className="sidebar-toggle" type="button" aria-label={isSidebarOpen ? "Hide conversations" : "Show conversations"} aria-expanded={isSidebarOpen} onClick={() => setIsSidebarOpen((open) => !open)}>
                            <svg aria-hidden="true" viewBox="0 0 24 24"><path d={isSidebarOpen ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} /></svg>
                        </button>
                        <div className="chat-heading">
                            <span className="avatar">{receiver?.name.slice(0, 1).toUpperCase() ?? "?"}</span>
                            <div><h1>{receiver?.name ?? "Choose a chat partner"}</h1><p><span className={`presence-dot ${receiverIsOnline ? "online" : "offline"}`} role="img" aria-label={receiverIsOnline ? "Online" : "Offline"} title={receiverIsOnline ? "Online" : "Offline"} /></p></div>
                        </div>
                    </div>
                    <div className="chat-header-end">
                        <button className="header-action danger-action" type="button" onClick={() => { setClearTarget("conversation"); setClearScope(null); setClearError(""); setDeleteDialogOpen(true); }} disabled={receiverId === null}>Clear chat</button>
                        <div className="signed-in-user"><span className="avatar">{initials}</span><div><strong>{userName}</strong><span><i className={`presence-dot ${isConnected ? "online" : "offline"}`} role="img" aria-label={isConnected ? "Online" : "Offline"} title={isConnected ? "Online" : "Offline"} /></span></div></div>
                    </div>
                </header>

                <div className="message-area" ref={messageAreaRef}>
                    <div className="day-divider"><span>Today</span></div>
                    <div className="selection-toolbar">
                        {isSelectingMessages ? <>
                            <span>{selectedMessageIds.length} selected</span>
                            <button type="button" className="header-action danger-action" onClick={openSelectedMessagesDelete} disabled={!selectedMessageIds.length}>Delete selected</button>
                            <button type="button" className="header-action" onClick={() => { setIsSelectingMessages(false); setSelectedMessageIds([]); }}>Cancel</button>
                        </> : <button type="button" className="header-action" onClick={() => setIsSelectingMessages(true)} disabled={!messages.length}>Select messages</button>}
                    </div>
                    {messages.length === 0 ? (
                        <div className="empty-state">
                            <div>
                                <div className="empty-icon">✦</div>
                                <h2>Your space to talk</h2>
                                <p>{loadError || (receiver ? `Send a message to ${receiver.name} and let the conversation begin.` : users.length ? "Choose a conversation to start chatting." : "Register another account to start chatting.")}</p>
                            </div>
                        </div>
                    ) : (
                        <div className="message-list">
                            {messages.map((chatMessage) => (
                                <div className={`message-row ${chatMessage.direction} ${selectedMessageIds.includes(chatMessage.id) ? "selected" : ""}`} key={chatMessage.id}>
                                    {isSelectingMessages && <input className="message-select" type="checkbox" checked={selectedMessageIds.includes(chatMessage.id)} onChange={(event) => toggleMessageSelection(chatMessage.id, event.target.checked)} aria-label={`Select message: ${chatMessage.text}`} />}
                                    <div className={`message-bubble ${chatMessage.mediaContentType ? "has-media" : ""}`}>
                                        {chatMessage.mediaContentType && <MessageMedia messageId={chatMessage.id} contentType={chatMessage.mediaContentType} fileName={chatMessage.mediaFileName} onSize={updateMediaFileSize} />}
                                        {chatMessage.text && <span className="message-text">{chatMessage.text}</span>}
                                        <span className="message-time">{chatMessage.time}{chatMessage.mediaFileSizeBytes !== undefined && <span className="media-size"> · {attachmentSizeLabel(chatMessage.mediaFileSizeBytes)}</span>}{chatMessage.queued ? " · Queued" : ""}{chatMessage.direction === "outgoing" && <span className={`message-status ${chatMessage.status ?? "sent"}`} title={chatMessage.status ?? "sent"} aria-label={chatMessage.status ?? "sent"}>{chatMessage.status === "sent" ? "✓" : "✓✓"}</span>}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="composer-wrap">
                    {sendError && <p className="form-error" role="alert">{sendError}</p>}
                    <form className="composer" onSubmit={sendMessage}>
                        <input type="text" placeholder="Write a message..." value={message} onChange={(event) => setMessage(event.target.value)} aria-label="Message" />
                        <div className="composer-actions">
                            <div className="emoji-control" ref={emojiControlRef}>
                                <button className={`composer-tool ${emojiPickerOpen ? "active" : ""}`} type="button" aria-label="Choose emoji" aria-expanded={emojiPickerOpen} onClick={() => setEmojiPickerOpen((open) => !open)}>☺</button>
                                {emojiPickerOpen && <div className="emoji-picker" role="group" aria-label="Frequently used emojis">
                                    {frequentEmojis.map((emoji) => <button type="button" key={emoji} onClick={() => setMessage((current) => `${current}${emoji}`)} aria-label={`Add ${emoji}`}>{emoji}</button>)}
                                </div>}
                            </div>
                            <input ref={mediaInputRef} className="visually-hidden" type="file" onChange={selectMedia} />
                            <button className="composer-tool" type="button" aria-label="Share a file" title="Share file" onClick={() => mediaInputRef.current?.click()} disabled={!isConnected || receiverId === null || isUploadingMedia}>＋</button>
                            <button className="send-button" type="submit" aria-label="Send message" disabled={!isConnected || receiverId === null || isUploadingMedia}>{isUploadingMedia ? "…" : "↑"}</button>
                        </div>
                    </form>
                    <p className="composer-hint">Press Enter to send · Share any file up to 20 MB</p>
                </div>
            </section>
            {pendingMedia && <div className="media-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isUploadingMedia && !isCompressingMedia) { setPendingMedia(null); setMediaCompressionError(""); } }}>
                <section className="media-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="media-preview-title">
                    <header className="media-preview-header"><h2 id="media-preview-title">Preview attachment</h2><button type="button" className="media-preview-close" onClick={() => setPendingMedia(null)} disabled={isUploadingMedia} aria-label="Cancel attachment">×</button></header>
                    <div className="media-preview-stage">
                        {pendingMedia.type.startsWith("image/")
                            ? <img src={pendingMediaPreview} alt={pendingMedia.name} />
                            : pendingMedia.type.startsWith("video/")
                                ? <video src={pendingMediaPreview} controls autoPlay muted />
                                : <div className="media-preview-file"><span aria-hidden="true">📎</span><strong>{pendingMedia.name}</strong><small>{(pendingMedia.size / (1024 * 1024)).toFixed(2)} MB</small></div>}
                    </div>
                    <div className="media-preview-footer">
                        <span className="media-preview-size">{isCompressingMedia ? mediaCompressionStatus : attachmentSizeLabel(pendingMedia.size)}</span>
                        <input type="text" placeholder="Add a caption..." value={message} onChange={(event) => setMessage(event.target.value)} aria-label="Attachment caption" onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void sendMedia(); } }} />
                        <button type="button" className="media-preview-send" onClick={() => void sendMedia()} disabled={isUploadingMedia || isCompressingMedia || !!mediaCompressionError} aria-label="Send attachment">{isCompressingMedia ? "Preparing…" : isUploadingMedia ? mediaUploadProgress ? `Sending ${mediaUploadProgress}%` : "Sending…" : "Send"}</button>
                    </div>
                    {mediaCompressionError && <p className="media-preview-error" role="alert">{mediaCompressionError}</p>}
                    {sendError && <p className="media-preview-error" role="alert">{sendError}</p>}
                </section>
            </div>}
            {deleteDialogOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isClearingChat) { setDeleteDialogOpen(false); setClearScope(null); } }}>
                <section className="action-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-dialog-title">
                    <div className="dialog-icon" aria-hidden="true">⌫</div>
                    {clearScope === null ? <>
                        <p className="dialog-eyebrow">Conversation controls</p>
                        <h2 id="clear-dialog-title">{clearTarget === "selected" ? `Delete ${selectedMessageIds.length} selected message${selectedMessageIds.length === 1 ? "" : "s"}` : "Clear chat"}</h2>
                        <p className="dialog-description">{clearTarget === "selected" ? `Choose whose view of this conversation with ${receiver?.name ?? "this user"} to clear.` : <>Choose whose chat history to clear with <strong>{receiver?.name ?? "this user"}</strong>.</>}</p>
                        <button type="button" className="clear-option" onClick={() => { setClearError(""); setClearScope("me"); }}>
                            <span><strong>{clearTarget === "selected" ? "Delete selected for me" : "Clear chat for me"}</strong><small>Only {userName}’s chat history is cleared.</small></span><span className="option-arrow" aria-hidden="true">›</span>
                        </button>
                        {isAdmin && <button type="button" className="clear-option" onClick={() => { setClearError(""); setClearScope("other"); }}>
                            <span><strong>{clearTarget === "selected" ? `Delete selected for ${receiver?.name ?? "the other user"}` : `Clear chat for ${receiver?.name ?? "the other user"}`}</strong><small>Only {receiver?.name ?? "the other user"}’s chat history is cleared.</small></span><span className="option-arrow" aria-hidden="true">›</span>
                        </button>}
                        {isAdmin && <button type="button" className="clear-option clear-option-danger" onClick={() => { setClearError(""); setClearScope("everyone"); }}>
                            <span><strong>{clearTarget === "selected" ? "Delete selected for everyone" : "Clear chat for everyone"}</strong><small>Messages are removed for both sides.</small></span><span className="option-arrow" aria-hidden="true">›</span>
                        </button>}
                        <button type="button" className="dialog-cancel" onClick={() => setDeleteDialogOpen(false)}>Cancel</button>
                    </> : <>
                        <p className="dialog-eyebrow">Please confirm</p>
                        <h2 id="clear-dialog-title">{clearScope === "me" ? `Clear ${clearTarget === "selected" ? "selected messages" : "your chat"}?` : clearScope === "other" ? `Clear ${clearTarget === "selected" ? "selected messages" : "chat"} for ${receiver?.name ?? "the other user"}?` : `Clear ${clearTarget === "selected" ? "selected messages" : "chat"} for everyone?`}</h2>
                        <p className="dialog-description">{clearScope === "me" ? `This clears ${clearTarget === "selected" ? "the selected messages" : "the conversation"} from ${userName}’s view. ${receiver?.name ?? "The other user"} keeps their messages.` : clearScope === "other" ? `This clears ${clearTarget === "selected" ? "the selected messages" : "the conversation"} from ${receiver?.name ?? "the other user"}’s view. Your messages remain visible to you.` : `This permanently removes ${clearTarget === "selected" ? "the selected messages" : "the conversation"} between ${userName} and ${receiver?.name ?? "the other user"} for both sides.`}</p>
                        {clearError && <p className="dialog-error" role="alert">{clearError}</p>}
                        <div className="dialog-actions">
                            <button type="button" className="dialog-cancel" onClick={() => setClearScope(null)} disabled={isClearingChat}>Back</button>
                            <button type="button" className="dialog-confirm" onClick={() => void deleteConversation()} disabled={isClearingChat}>{isClearingChat ? "Clearing…" : clearTarget === "selected" ? "Confirm delete" : "Confirm clear"}</button>
                        </div>
                    </>}
                </section>
            </div>}
            {availabilityDialogOpen && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !isChangingAvailability) setAvailabilityDialogOpen(false); }}>
                <section className="action-dialog compact-dialog" role="dialog" aria-modal="true" aria-labelledby="availability-dialog-title">
                    <div className="dialog-icon power-icon" aria-hidden="true">⏻</div>
                    <p className="dialog-eyebrow">Application status</p>
                    <h2 id="availability-dialog-title">{isAvailable ? "Turn Chat Anytime off?" : "Turn Chat Anytime on?"}</h2>
                    <p className="dialog-description">{isAvailable ? "Other users will see the unavailable page until you turn the app back on. Stark can still sign in." : "Other users will be able to sign in and chat again."}</p>
                    <div className="dialog-actions">
                        <button type="button" className="dialog-cancel" onClick={() => setAvailabilityDialogOpen(false)} disabled={isChangingAvailability}>Cancel</button>
                        <button type="button" className="dialog-confirm" onClick={() => void toggleApplicationAvailability()} disabled={isChangingAvailability}>{isChangingAvailability ? "Updating…" : isAvailable ? "Turn off" : "Turn on"}</button>
                    </div>
                </section>
            </div>}
        </main>
    );
}

export default Chat;
