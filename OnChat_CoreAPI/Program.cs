using ChatAPI.Data;
using ChatAPI.Services;
using ChatAPI.Hubs;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using System.Text;
using System.Threading.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey) || Encoding.UTF8.GetByteCount(jwtKey) < 32)
{
    throw new InvalidOperationException("Jwt:Key must contain at least 32 bytes of cryptographically random data.");
}

// Keep development startup independent of Windows Event Log permissions.
builder.Logging.ClearProviders();
builder.Logging.AddConsole();

// Add services to the container.

builder.Services.AddControllers();
builder.Services.Configure<PasswordHasherOptions>(options => options.IterationCount = 600_000);
builder.Services.AddScoped<IPasswordHasher<ChatAPI.Models.User>, PasswordHasher<ChatAPI.Models.User>>();

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // The API is published only on host loopback and receives external requests
    // through the Nginx container on the private Compose network.
    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();
    options.ForwardLimit = 2;
});

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("auth", context =>
    {
        var clientKey = context.Connection.RemoteIpAddress?.ToString() ?? "unknown-client";
        return RateLimitPartition.GetFixedWindowLimiter(clientKey, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 10,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true
        });
    });
});

builder.Services.AddSignalR();
builder.Services.AddSingleton<IUserIdProvider, JwtUserIdProvider>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("ReactPolicy", policy =>
    {
        // Allow local Vite origins in development and the explicitly configured
        // public UI origin in Docker deployments.
        var configuredOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
        policy.SetIsOriginAllowed(origin =>
                (Uri.TryCreate(origin, UriKind.Absolute, out var uri) && uri.IsLoopback)
                || configuredOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase))
            .AllowAnyHeader()
            .AllowAnyMethod()
            .AllowCredentials();
    });
});

// Learn more about configuring Swagger/OpenAPI at https://aka.ms/aspnetcore/swashbuckle
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Chat API",
        Version = "v1"
    });

    options.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Name = "Authorization",
        Type = SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "JWT",
        In = ParameterLocation.Header,
        Description = "Enter JWT Token like: Bearer {your token}"
    });

    options.AddSecurityRequirement(new OpenApiSecurityRequirement
    {
        {
            new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "Bearer"
                }
            },
            Array.Empty<string>()
        }
    });
});

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience=true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,

            ValidIssuer = builder.Configuration["Jwt:Issuer"],
            ValidAudience = builder.Configuration["Jwt:Audience"],

            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!))
                
        };
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"];
                var path = context.HttpContext.Request.Path;

                if(!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/chatHub"))
                {
                    context.Token = accessToken;
                }
                return Task.CompletedTask;
            }
        };
    });

builder.Services.AddAuthorization();

builder.Services.AddDbContext<ApplicationDbContext>(options => options.UseSqlServer(builder.Configuration.GetConnectionString("connect")));

builder.Services.AddScoped<TokenService>();
builder.Services.AddSingleton<ApplicationAvailability>();

var app = builder.Build();

// Apply pending additive schema migrations before serving authenticated endpoints.
// Existing user and message rows remain in place; the current API requires these
// columns for the user list, message visibility, and media features.
using (var migrationScope = app.Services.CreateScope())
{
    var dbContext = migrationScope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
    dbContext.Database.Migrate();

    // Convert existing plain-text credentials once, then erase the old values.
    var passwordHasher = migrationScope.ServiceProvider.GetRequiredService<IPasswordHasher<ChatAPI.Models.User>>();
    var usersWithLegacyPasswords = await dbContext.Users
        .Where(user => user.PasswordHash == null)
        .ToListAsync();
    foreach (var user in usersWithLegacyPasswords)
    {
        user.PasswordHash = passwordHasher.HashPassword(user, user.Password);
        user.Password = string.Empty;
    }
    if (usersWithLegacyPasswords.Count > 0)
    {
        await dbContext.SaveChangesAsync();
    }
}

app.UseForwardedHeaders();
app.UseRouting();
app.UseRateLimiter();

app.UseCors("ReactPolicy");

app.UseAuthentication();
app.Use(async (context, next) =>
{
    var availability = context.RequestServices.GetRequiredService<ApplicationAvailability>();
    var path = context.Request.Path;
    var statusEndpoint = path.Equals("/System/Status", StringComparison.OrdinalIgnoreCase);
    var availabilityEndpoint = path.Equals("/System/Availability", StringComparison.OrdinalIgnoreCase);
    var loginEndpoint = path.Equals("/Login", StringComparison.OrdinalIgnoreCase);
    var isAdmin = AdminAccess.IsAdmin(context.User, context.RequestServices.GetRequiredService<IConfiguration>());
    if (!availability.IsAvailable && !isAdmin && !statusEndpoint && !availabilityEndpoint && !loginEndpoint)
    {
        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        await context.Response.WriteAsJsonAsync(new { message = "Chat Anytime is currently unavailable." });
        return;
    }
    await next();
});
app.UseAuthorization();

app.MapHub<ChatHub>("/chatHub");

app.MapControllers();


// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}


app.Run();
