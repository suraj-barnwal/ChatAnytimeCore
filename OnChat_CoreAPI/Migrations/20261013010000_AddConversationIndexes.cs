using ChatAPI.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChatAPI.Migrations
{
    [DbContext(typeof(ApplicationDbContext))]
    [Migration("20261013010000_AddConversationIndexes")]
    public partial class AddConversationIndexes : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Messages_Sender_Receiver_SentTime",
                table: "Messages",
                columns: new[] { "SenderId", "ReceiverId", "SentTime" });

            migrationBuilder.CreateIndex(
                name: "IX_Messages_Receiver_Sender_SentTime",
                table: "Messages",
                columns: new[] { "ReceiverId", "SenderId", "SentTime" });
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_Messages_Sender_Receiver_SentTime", table: "Messages");
            migrationBuilder.DropIndex(name: "IX_Messages_Receiver_Sender_SentTime", table: "Messages");
        }
    }
}
