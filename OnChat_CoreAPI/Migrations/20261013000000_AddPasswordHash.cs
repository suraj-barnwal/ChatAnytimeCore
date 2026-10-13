using ChatAPI.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChatAPI.Migrations
{
    [DbContext(typeof(ApplicationDbContext))]
    [Migration("20261013000000_AddPasswordHash")]
    public partial class AddPasswordHash : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "PasswordHash",
                table: "Users",
                type: "nvarchar(500)",
                maxLength: 500,
                nullable: true);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            throw new NotSupportedException("Password hashes cannot be safely reverted to the previous plain-text password format.");
        }
    }
}
