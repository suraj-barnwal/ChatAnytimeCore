using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;

namespace ChatAPI.Models
{
    public class Message
    {
        [Key]
        public int MessageId { get; set; }

        public int SenderId { get; set; }

        public int ReceiverId { get; set; }

        [Required]
        public string Text { get; set; } = string.Empty;

        [MaxLength(100)]
        public string? MediaContentType { get; set; }

        [MaxLength(255)]
        public string? MediaFileName { get; set; }

        public byte[]? MediaData { get; set; }

        public DateTime SentTime { get; set; } = DateTime.Now;

        public bool IsRead { get; set; }

        public bool IsDelivered { get; set; }

        public bool IsHiddenForSender { get; set; }

        public bool IsHiddenForReceiver { get; set; }

        [ForeignKey("SenderId")]
        public User? Sender { get; set; }

        [ForeignKey("ReceiverId")]
        public User? Receiver { get; set; }
    }
}
