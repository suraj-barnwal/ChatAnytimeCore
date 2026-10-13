using ChatAPI.Models;
using Microsoft.EntityFrameworkCore;

namespace ChatAPI.Data
{
    public class ApplicationDbContext : DbContext
    {
        public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
            : base(options)
        {
        }

        public DbSet<User> Users { get; set; }

        public DbSet<Message> Messages { get; set; }

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Message>()
                .HasIndex(message => new { message.SenderId, message.ReceiverId, message.SentTime })
                .HasDatabaseName("IX_Messages_Sender_Receiver_SentTime");

            modelBuilder.Entity<Message>()
                .HasIndex(message => new { message.ReceiverId, message.SenderId, message.SentTime })
                .HasDatabaseName("IX_Messages_Receiver_Sender_SentTime");

            modelBuilder.Entity<Message>()
                .HasOne(m => m.Sender)
                .WithMany()
                .HasForeignKey(m => m.SenderId)
                .OnDelete(DeleteBehavior.NoAction);

            modelBuilder.Entity<Message>()
                .HasOne(m => m.Receiver)
                .WithMany()
                .HasForeignKey(m => m.ReceiverId)
                .OnDelete(DeleteBehavior.NoAction);

            base.OnModelCreating(modelBuilder);
        }
    }
}
