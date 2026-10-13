using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using ChatAPI.Data;
using ChatAPI.Models;
using Microsoft.EntityFrameworkCore;
using System.Collections.Concurrent;
using System.Security.Claims;

namespace ChatAPI.Hubs
{
    [Authorize]
    public class ChatHub : Hub
    {
        private readonly ApplicationDbContext _dbContext;

        public ChatHub(ApplicationDbContext dbContext)
        {
            _dbContext = dbContext;
        }

        // User IDs are strings from the JWT. SignalR can have several connections per user.
        private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> Connections = new();

        public override async Task OnConnectedAsync()
        {
            var userId = GetUserId(Context.User);
            if (userId is null)
            {
                Context.Abort();
                return;
            }

            var userConnections = Connections.GetOrAdd(userId, _ => new ConcurrentDictionary<string, byte>());
            userConnections[Context.ConnectionId] = 0;
            await Clients.All.SendAsync("OnlineUsers", Connections.Keys.ToArray());
            await base.OnConnectedAsync();
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            var userId = GetUserId(Context.User);
            if (userId is not null && Connections.TryGetValue(userId, out var userConnections))
            {
                userConnections.TryRemove(Context.ConnectionId, out _);
                if (userConnections.IsEmpty) Connections.TryRemove(userId, out _);
                await Clients.All.SendAsync("OnlineUsers", Connections.Keys.ToArray());
            }

            await base.OnDisconnectedAsync(exception);
        }

        public async Task<object> SendMessage(int receiverId, string message)
        {
            var senderId = GetUserId(Context.User);
            if (!int.TryParse(senderId, out var parsedSenderId))
                throw new HubException("User is not authenticated");
            if (receiverId == parsedSenderId)
                return new { messageId = 0, queued = false, error = "Choose another user to send a message." };
            if (string.IsNullOrWhiteSpace(message))
                throw new HubException("Message cannot be empty.");

            var savedMessage = new Message
            {
                SenderId = parsedSenderId,
                ReceiverId = receiverId,
                Text = message.Trim(),
                SentTime = DateTime.UtcNow,
                IsRead = false
            };
            _dbContext.Messages.Add(savedMessage);
            try
            {
                // The foreign key validates the recipient as part of the insert,
                // avoiding a separate database round trip before every send.
                await _dbContext.SaveChangesAsync();
            }
            catch (DbUpdateException)
            {
                _dbContext.Entry(savedMessage).State = EntityState.Detached;
                throw new HubException("Message could not be saved. Check the recipient and try again.");
            }

            // Persist first; the recipient can fetch it later if currently offline.
            var recipientIsOnline = IsUserOnline(receiverId.ToString());
            await Clients.User(receiverId.ToString()).SendAsync(
                "ReceiveMessage", savedMessage.MessageId, parsedSenderId, receiverId, savedMessage.Text, savedMessage.SentTime);
            return new { messageId = savedMessage.MessageId, queued = !recipientIsOnline, error = (string?)null };
        }

        public async Task AcknowledgeMessage(int messageId, bool isSeen)
        {
            var currentUserId = GetUserId(Context.User);
            if (!int.TryParse(currentUserId, out var receiverId))
                throw new HubException("User is not authenticated.");

            var message = await _dbContext.Messages.FirstOrDefaultAsync(item => item.MessageId == messageId);
            if (message is null || message.ReceiverId != receiverId)
                throw new HubException("Message not found for this user.");

            var changed = !message.IsDelivered || (isSeen && !message.IsRead);
            if (!changed) return;

            message.IsDelivered = true;
            if (isSeen) message.IsRead = true;
            await _dbContext.SaveChangesAsync();

            var status = message.IsRead ? "seen" : "received";
            await Clients.User(message.SenderId.ToString()).SendAsync("MessageStatusUpdated", message.MessageId, status);
        }

        internal static string? GetUserId(ClaimsPrincipal? principal) =>
            principal?.FindFirst(ClaimTypes.NameIdentifier)?.Value
            ?? principal?.FindFirst("nameid")?.Value
            ?? principal?.FindFirst("sub")?.Value;

        internal static bool IsUserOnline(string userId) => Connections.ContainsKey(userId);
    }

    public sealed class JwtUserIdProvider : IUserIdProvider
    {
        public string? GetUserId(HubConnectionContext connection) => ChatHub.GetUserId(connection.User);
    }
}
