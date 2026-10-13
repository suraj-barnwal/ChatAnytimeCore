using System.Security.Claims;

namespace ChatAPI.Services
{
    public static class AdminAccess
    {
        public static bool IsAdmin(ClaimsPrincipal principal, IConfiguration configuration)
        {
            if (principal.IsInRole("Admin")) return true;
            var email = principal.FindFirstValue(ClaimTypes.Email) ?? principal.FindFirstValue("email");
            return IsConfiguredAdmin(email, configuration);
        }

        public static bool IsConfiguredAdmin(string? email, IConfiguration configuration)
        {
            var adminEmail = configuration["Admin:Email"];
            return !string.IsNullOrWhiteSpace(adminEmail)
                && !string.IsNullOrWhiteSpace(email)
                && string.Equals(email.Trim(), adminEmail.Trim(), StringComparison.OrdinalIgnoreCase);
        }
    }
}
