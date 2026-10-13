using ChatAPI.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace ChatAPI.Controllers
{
    [ApiController]
    [Route("System")]
    public sealed class SystemController : ControllerBase
    {
        private readonly ApplicationAvailability _availability;
        private readonly IConfiguration _configuration;

        public SystemController(ApplicationAvailability availability, IConfiguration configuration)
        {
            _availability = availability;
            _configuration = configuration;
        }

        [AllowAnonymous]
        [HttpGet("Status")]
        public IActionResult Status() => Ok(new { isAvailable = _availability.IsAvailable });

        [Authorize]
        [HttpPost("Availability")]
        public IActionResult SetAvailability([FromBody] AvailabilityRequest request)
        {
            if (!AdminAccess.IsAdmin(User, _configuration)) return Forbid();
            _availability.SetAvailable(request.IsAvailable);
            return Ok(new { isAvailable = _availability.IsAvailable });
        }

        public sealed record AvailabilityRequest(bool IsAvailable);
    }
}
