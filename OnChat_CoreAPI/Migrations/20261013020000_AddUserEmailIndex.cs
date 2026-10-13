using ChatAPI.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChatAPI.Migrations
{
    [DbContext(typeof(ApplicationDbContext))]
    [Migration("20261013020000_AddUserEmailIndex")]
    public partial class AddUserEmailIndex : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Users_Email",
                table: "Users",
                column: "Email");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(name: "IX_Users_Email", table: "Users");
        }
    }
}
