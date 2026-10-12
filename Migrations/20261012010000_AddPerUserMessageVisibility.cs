using ChatAPI.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChatAPI.Migrations
{
    [DbContext(typeof(ApplicationDbContext))]
    [Migration("20261012010000_AddPerUserMessageVisibility")]
    public partial class AddPerUserMessageVisibility : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "IsHiddenForSender",
                table: "Messages",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<bool>(
                name: "IsHiddenForReceiver",
                table: "Messages",
                type: "bit",
                nullable: false,
                defaultValue: false);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(name: "IsHiddenForSender", table: "Messages");
            migrationBuilder.DropColumn(name: "IsHiddenForReceiver", table: "Messages");
        }
    }
}
