using ChatAPI.Data;
using ChatAPI.DTOs;
using ChatAPI.Models;
using ChatAPI.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace ChatAPI.Controllers
{
    public class AuthController : Controller
    {
        private readonly ApplicationDbContext _context;
        private readonly TokenService _tokenService;

        public AuthController(ApplicationDbContext context, TokenService tokenService)
        {
            _context = context;
            _tokenService = tokenService;
        }

        [HttpPost("Register")]
        public async Task<IActionResult> Register(RegisterDto model)
        {
            var user = await _context.Users.FirstOrDefaultAsync(x => x.Email == model.Email);

            if (user != null)
            {
                return BadRequest("Email Already Exists");
            }

            User newUser = new User
            {
                Name = model.Name,
                Email = model.Email,
                Password = model.Password
            };

            _context.Add(newUser);
            await _context.SaveChangesAsync();


            return Ok("User Registered Successfully");
        }

        [HttpPost("Login")]
        public async Task<IActionResult> Login(LoginDto model)
        {
            var user = await _context.Users.FirstOrDefaultAsync(x =>
                x.Email == model.Email &&
                x.Password == model.Password);

            if (user == null)
            {
                return Unauthorized("Invalid Email or Password");
            }

            var token = _tokenService.CreateToken(user);

            return Ok(new
            {
                Message = "Login Successful",
                Token = token,
                UserId = user.UserId,
                Name = user.Name,
                Email = user.Email
            });
        }
    }
}
