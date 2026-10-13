using ChatAPI.Models;
using Microsoft.IdentityModel.Tokens;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;

namespace ChatAPI.Services
{
    public class TokenService
    {
        public readonly IConfiguration _confuguration;
        public TokenService(IConfiguration configuration)
        {
            _confuguration = configuration;
        }

        public string CreateToken(User user)
        {
            var adminEmail = _confuguration["Admin:Email"];
            var isAdmin = !string.IsNullOrWhiteSpace(adminEmail)
                && string.Equals(user.Email, adminEmail.Trim(), StringComparison.OrdinalIgnoreCase);
            var claims = new[]
            {
                new Claim(ClaimTypes.NameIdentifier, user.UserId.ToString()),
                new Claim(ClaimTypes.Name,user.Name),
                new Claim(ClaimTypes.Email, user.Email),
                new Claim(ClaimTypes.Role, isAdmin ? "Admin" : "User")
            };

            var key = new SymmetricSecurityKey(
                Encoding.UTF8.GetBytes(_confuguration["Jwt:Key"]!));

            var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);

            var token = new JwtSecurityToken(
                issuer: _confuguration["Jwt:Issuer"],
                audience: _confuguration["Jwt:Audience"],
                claims: claims,
                expires: DateTime.UtcNow.AddHours(1),
                signingCredentials:creds);

            return new JwtSecurityTokenHandler().WriteToken(token);
        }
    }
}
