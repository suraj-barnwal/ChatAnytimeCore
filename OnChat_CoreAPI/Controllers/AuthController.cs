using ChatAPI.Data;
using ChatAPI.DTOs;
using ChatAPI.Models;
using ChatAPI.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Authorization;
using System.Security.Claims;
using ChatAPI.Hubs;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using System.ComponentModel.DataAnnotations;

namespace ChatAPI.Controllers
{
    public class AuthController : Controller
    {
        private readonly ApplicationDbContext _context;
        private readonly TokenService _tokenService;
        private readonly IHubContext<ChatHub> _chatHub;
        private readonly IConfiguration _configuration;
        private readonly IPasswordHasher<User> _passwordHasher;

        public AuthController(ApplicationDbContext context, TokenService tokenService, IHubContext<ChatHub> chatHub, IConfiguration configuration, IPasswordHasher<User> passwordHasher)
        {
            _context = context;
            _tokenService = tokenService;
            _chatHub = chatHub;
            _configuration = configuration;
            _passwordHasher = passwordHasher;
        }

        [Authorize]
        [HttpGet("Users")]
        public async Task<IActionResult> Users()
        {
            var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? User.FindFirstValue("nameid")
                ?? User.FindFirstValue("sub");
            if (!int.TryParse(currentUserId, out var userId)) return Unauthorized();

            var summaries = await _context.Users
                .AsNoTracking()
                .Where(user => user.UserId != userId)
                .Select(user => new
                {
                    user.UserId,
                    user.Name,
                    LastMessage = _context.Messages
                        .Where(message =>
                            (message.SenderId == userId && message.ReceiverId == user.UserId && !message.IsHiddenForSender) ||
                            (message.SenderId == user.UserId && message.ReceiverId == userId && !message.IsHiddenForReceiver))
                        .OrderByDescending(message => message.SentTime)
                        .ThenByDescending(message => message.MessageId)
                        .Select(message => new
                        {
                            message.Text,
                            message.SentTime,
                            message.MediaContentType
                        })
                        .FirstOrDefault(),
                    UnreadCount = _context.Messages.Count(message =>
                        message.SenderId == user.UserId && message.ReceiverId == userId &&
                        !message.IsRead && !message.IsHiddenForReceiver)
                })
                .ToListAsync();

            return Ok(summaries
                .OrderByDescending(user => user.LastMessage?.SentTime ?? DateTime.MinValue)
                .ThenBy(user => user.Name)
                .Select(user => new
                {
                    user.UserId,
                    user.Name,
                    LastMessageText = user.LastMessage?.Text,
                    LastMessageTime = user.LastMessage is null
                        ? (DateTime?)null
                        : DateTime.SpecifyKind(user.LastMessage.SentTime, DateTimeKind.Utc),
                    LastMessageContentType = user.LastMessage?.MediaContentType,
                    user.UnreadCount
                }));
        }

        [Authorize]
        [HttpGet("Me")]
        public async Task<IActionResult> Me()
        {
            var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? User.FindFirstValue("nameid")
                ?? User.FindFirstValue("sub");
            if (!int.TryParse(currentUserId, out var userId)) return Unauthorized();

            var user = await _context.Users
                .Where(item => item.UserId == userId)
                .Select(item => new { item.UserId, item.Name, item.Email })
                .FirstOrDefaultAsync();
            return user is null ? Unauthorized() : Ok(new { user.UserId, user.Name, IsAdmin = AdminAccess.IsConfiguredAdmin(user.Email, _configuration) });
        }

        [Authorize]
        [HttpGet("Messages/{otherUserId:int}")]
        public async Task<IActionResult> Messages(int otherUserId)
        {
            var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? User.FindFirstValue("nameid")
                ?? User.FindFirstValue("sub");
            if (!int.TryParse(currentUserId, out var userId)) return Unauthorized();
            if (userId == otherUserId) return BadRequest("You cannot open a conversation with yourself.");

            var conversation = await _context.Messages
                .Where(message =>
                (message.SenderId == userId && message.ReceiverId == otherUserId) ||
                    (message.SenderId == otherUserId && message.ReceiverId == userId))
                .Where(message => message.SenderId == userId
                    ? !message.IsHiddenForSender
                    : !message.IsHiddenForReceiver)
                .OrderBy(message => message.SentTime)
                .Select(message => new
                {
                    message.MessageId,
                    message.SenderId,
                    message.ReceiverId,
                    message.Text,
                    message.MediaContentType,
                    message.MediaFileName,
                    message.SentTime,
                    message.IsDelivered,
                    message.IsRead
                })
                .ToListAsync();

            var newlySeen = conversation.Where(message => message.ReceiverId == userId && !message.IsRead).ToList();
            if (newlySeen.Count > 0)
            {
                var newlySeenIds = newlySeen.Select(message => message.MessageId).ToList();
                await _context.Messages.Where(message => newlySeenIds.Contains(message.MessageId))
                    .ExecuteUpdateAsync(update => update
                        .SetProperty(message => message.IsDelivered, true)
                        .SetProperty(message => message.IsRead, true));
                foreach (var message in newlySeen)
                {
                    await _chatHub.Clients.User(message.SenderId.ToString())
                        .SendAsync("MessageStatusUpdated", message.MessageId, "seen");
                }
            }

            return Ok(conversation.Select(message => new
            {
                id = message.MessageId,
                senderId = message.SenderId,
                receiverId = message.ReceiverId,
                text = message.Text,
                mediaContentType = message.MediaContentType,
                mediaFileName = message.MediaFileName,
                // SQL Server DateTime values return with Kind=Unspecified. These timestamps
                // are stored in UTC, so mark them explicitly for clients to localize correctly.
                sentTime = DateTime.SpecifyKind(message.SentTime, DateTimeKind.Utc),
                isDelivered = message.IsDelivered || message.ReceiverId == userId,
                isRead = message.IsRead || message.ReceiverId == userId
            }));
        }

        [Authorize]
        [HttpPost("Messages/Media")]
        [Consumes("multipart/form-data")]
        [RequestSizeLimit(21 * 1024 * 1024)]
        public async Task<IActionResult> SendMedia([FromForm] int receiverId, [FromForm] string? text, [FromForm] IFormFile file)
        {
            var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? User.FindFirstValue("nameid")
                ?? User.FindFirstValue("sub");
            if (!int.TryParse(currentUserId, out var senderId)) return Unauthorized();
            if (receiverId == senderId) return BadRequest("Choose another user.");
            if (file is null || file.Length == 0) return BadRequest("Choose a file to send.");
            if (file.Length > 20 * 1024 * 1024) return BadRequest("Files must be 20 MB or smaller.");
            var contentType = string.IsNullOrWhiteSpace(file.ContentType) || file.ContentType.Length > 100 || file.ContentType.Contains('\r') || file.ContentType.Contains('\n')
                ? "application/octet-stream"
                : file.ContentType;
            if (contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) && file.Length >= 500 * 1024)
                return BadRequest("Images must be below 500 KB after compression.");
            if (contentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase) && file.Length >= 1024 * 1024)
                return BadRequest("Videos must be below 1 MB after compression.");
            if (!await _context.Users.AnyAsync(user => user.UserId == receiverId)) return NotFound("User not found.");

            await using var stream = new MemoryStream();
            await file.CopyToAsync(stream);
            var fileName = Path.GetFileName(file.FileName);
            if (fileName.Length > 255) fileName = fileName[^255..];
            var savedMessage = new Message
            {
                SenderId = senderId,
                ReceiverId = receiverId,
                Text = (text ?? string.Empty).Trim(),
                // Keep arbitrary MIME types; some browsers leave uncommon files blank.
                MediaContentType = contentType,
                MediaFileName = fileName,
                MediaData = stream.ToArray(),
                SentTime = DateTime.UtcNow,
                IsRead = false
            };
            _context.Messages.Add(savedMessage);
            await _context.SaveChangesAsync();

            var recipientIsOnline = ChatHub.IsUserOnline(receiverId.ToString());
            await _chatHub.Clients.User(receiverId.ToString()).SendAsync(
                "ReceiveMessage", savedMessage.MessageId, senderId, receiverId,
                savedMessage.Text, savedMessage.SentTime, savedMessage.MediaContentType, savedMessage.MediaFileName);

            return Ok(new
            {
                id = savedMessage.MessageId,
                senderId,
                receiverId,
                text = savedMessage.Text,
                sentTime = DateTime.SpecifyKind(savedMessage.SentTime, DateTimeKind.Utc),
                mediaContentType = savedMessage.MediaContentType,
                mediaFileName = savedMessage.MediaFileName,
                isDelivered = false,
                isRead = false,
                queued = !recipientIsOnline
            });
        }

        [Authorize]
        [HttpGet("Messages/Media/{messageId:int}")]
        public async Task<IActionResult> GetMessageMedia(int messageId)
        {
            var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? User.FindFirstValue("nameid")
                ?? User.FindFirstValue("sub");
            if (!int.TryParse(currentUserId, out var userId)) return Unauthorized();

            var message = await _context.Messages.FirstOrDefaultAsync(item => item.MessageId == messageId &&
                (item.SenderId == userId && !item.IsHiddenForSender ||
                 item.ReceiverId == userId && !item.IsHiddenForReceiver));
            if (message?.MediaData is null || string.IsNullOrWhiteSpace(message.MediaContentType)) return NotFound();
            return File(message.MediaData, message.MediaContentType);
        }

        [Authorize]
        [HttpDelete("Messages/{otherUserId:int}")]
        public async Task<IActionResult> DeleteConversationMessages(int otherUserId, [FromQuery] string scope = "everyone")
        {
            var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? User.FindFirstValue("nameid")
                ?? User.FindFirstValue("sub");
            if (!int.TryParse(currentUserId, out var userId)) return Unauthorized();
            var isAdmin = AdminAccess.IsAdmin(User, _configuration);
            if (!isAdmin && !string.Equals(scope, "me", StringComparison.OrdinalIgnoreCase)) return Forbid();
            if (userId == otherUserId) return BadRequest("Choose another user.");

            var otherUserExists = await _context.Users.AnyAsync(user => user.UserId == otherUserId);
            if (!otherUserExists) return NotFound("User not found.");

            var conversationQuery = _context.Messages.Where(message =>
                (message.SenderId == userId && message.ReceiverId == otherUserId) ||
                (message.SenderId == otherUserId && message.ReceiverId == userId));
            int deletedCount;
            if (string.Equals(scope, "me", StringComparison.OrdinalIgnoreCase))
            {
                var hiddenSent = await conversationQuery.Where(message => message.SenderId == userId)
                    .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForSender, true));
                var hiddenReceived = await conversationQuery.Where(message => message.ReceiverId == userId)
                    .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForReceiver, true));
                deletedCount = hiddenSent + hiddenReceived;
            }
            else if (string.Equals(scope, "other", StringComparison.OrdinalIgnoreCase))
            {
                if (!isAdmin) return Forbid();
                var hiddenAdminSent = await conversationQuery.Where(message => message.SenderId == userId)
                    .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForReceiver, true));
                var hiddenAdminReceived = await conversationQuery.Where(message => message.ReceiverId == userId)
                    .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForSender, true));
                deletedCount = hiddenAdminSent + hiddenAdminReceived;
            }
            else if (string.Equals(scope, "everyone", StringComparison.OrdinalIgnoreCase))
            {
                if (!isAdmin) return Forbid();
                deletedCount = await conversationQuery.ExecuteDeleteAsync();
            }
            else
            {
                return BadRequest("Scope must be 'me', 'other', or 'everyone'.");
            }
            if (string.Equals(scope, "everyone", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(scope, "other", StringComparison.OrdinalIgnoreCase))
            {
                await _chatHub.Clients.User(otherUserId.ToString())
                    .SendAsync("ConversationDeleted", userId);
            }

            return Ok(new { deletedCount });
        }

        [Authorize]
        [HttpDelete("Messages/Selected")]
        public async Task<IActionResult> DeleteSelectedMessages([FromBody] DeleteMessagesRequest request)
        {
            var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier)
                ?? User.FindFirstValue("nameid")
                ?? User.FindFirstValue("sub");
            if (!int.TryParse(currentUserId, out var userId)) return Unauthorized();
            if (request.MessageIds is null || request.MessageIds.Count == 0 || request.MessageIds.Count > 500)
                return BadRequest("Select between 1 and 500 messages.");

            var isAdmin = AdminAccess.IsAdmin(User, _configuration);
            var scope = request.Scope?.Trim().ToLowerInvariant() ?? "me";
            if (!isAdmin && scope != "me") return Forbid();
            if (scope is not ("me" or "other" or "everyone"))
                return BadRequest("Scope must be 'me', 'other', or 'everyone'.");

            var ids = request.MessageIds.Distinct().ToList();
            var messages = await _context.Messages
                .Where(message => ids.Contains(message.MessageId) &&
                    (message.SenderId == userId || message.ReceiverId == userId))
                .Select(message => new { message.MessageId, message.SenderId, message.ReceiverId })
                .ToListAsync();
            if (messages.Count != ids.Count) return NotFound("One or more selected messages were not found in your conversations.");

            var selectedIds = messages.Select(message => message.MessageId).ToList();
            int deletedCount;
            if (scope == "everyone")
            {
                deletedCount = await _context.Messages.Where(message => selectedIds.Contains(message.MessageId)).ExecuteDeleteAsync();
            }
            else
            {
                if (scope == "me")
                {
                    await _context.Messages.Where(message => selectedIds.Contains(message.MessageId) && message.SenderId == userId)
                        .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForSender, true));
                    await _context.Messages.Where(message => selectedIds.Contains(message.MessageId) && message.ReceiverId == userId)
                        .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForReceiver, true));
                    deletedCount = messages.Count;
                }
                else
                {
                    await _context.Messages.Where(message => selectedIds.Contains(message.MessageId) && message.SenderId == userId)
                        .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForReceiver, true));
                    await _context.Messages.Where(message => selectedIds.Contains(message.MessageId) && message.ReceiverId == userId)
                        .ExecuteUpdateAsync(update => update.SetProperty(message => message.IsHiddenForSender, true));
                    deletedCount = messages.Count;
                }
            }

            var affectedUserIds = messages
                .Select(message => message.SenderId == userId ? message.ReceiverId : message.SenderId)
                .Distinct();
            foreach (var affectedUserId in affectedUserIds)
            {
                if (scope is "other" or "everyone")
                    await _chatHub.Clients.User(affectedUserId.ToString())
                        .SendAsync("MessagesDeleted", userId, ids);
            }

            return Ok(new { deletedCount });
        }

        [EnableRateLimiting("auth")]
        [HttpPost("Register")]
        public async Task<IActionResult> Register([FromBody] RegisterDto model)
        {
            var name = model.Name?.Trim();
            var email = model.Email?.Trim();
            var password = model.Password;
            if (string.IsNullOrWhiteSpace(name) || name.Length > 100 ||
                string.IsNullOrWhiteSpace(email) || email.Length > 100 ||
                !new EmailAddressAttribute().IsValid(email) ||
                string.IsNullOrEmpty(password) || password.Length < 12 || password.Length > 128)
            {
                return BadRequest("Enter a valid name and email, and a password between 12 and 128 characters.");
            }

            var adminEmail = _configuration["Admin:Email"];
            if (!string.IsNullOrWhiteSpace(adminEmail) &&
                string.Equals(email, adminEmail.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                return BadRequest("The configured administrator account must be provisioned privately.");
            }

            var user = await _context.Users.FirstOrDefaultAsync(x => x.Email == email);

            if (user != null)
            {
                return BadRequest("Email Already Exists");
            }

            User newUser = new User
            {
                Name = name,
                Email = email,
                Password = string.Empty
            };
            newUser.PasswordHash = _passwordHasher.HashPassword(newUser, password);

            _context.Add(newUser);
            await _context.SaveChangesAsync();


            return Ok("User Registered Successfully");
        }

        [EnableRateLimiting("auth")]
        [HttpPost("Login")]
        public async Task<IActionResult> Login([FromBody] LoginDto model)
        {
            if (string.IsNullOrWhiteSpace(model.Email) || string.IsNullOrEmpty(model.Password))
                return Unauthorized("Invalid Email or Password");

            var user = await _context.Users.FirstOrDefaultAsync(x => x.Email == model.Email.Trim());

            if (user?.PasswordHash is null)
            {
                return Unauthorized("Invalid Email or Password");
            }

            var verification = _passwordHasher.VerifyHashedPassword(user, user.PasswordHash, model.Password);
            if (verification == PasswordVerificationResult.Failed)
            {
                return Unauthorized("Invalid Email or Password");
            }
            if (verification == PasswordVerificationResult.SuccessRehashNeeded)
            {
                user.PasswordHash = _passwordHasher.HashPassword(user, model.Password);
                await _context.SaveChangesAsync();
            }

            var token = _tokenService.CreateToken(user);

            return Ok(new
            {
                Message = "Login Successful",
                Token = token,
                UserId = user.UserId,
                Name = user.Name,
                Email = user.Email,
                IsAdmin = AdminAccess.IsConfiguredAdmin(user.Email, _configuration)
            });
        }
    }
}
