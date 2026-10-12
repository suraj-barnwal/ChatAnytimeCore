using ChatAPI.Data;
using ChatAPI.Services;
using ChatAPI.Hubs;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Microsoft.OpenApi.Models;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

// Keep development startup independent of Windows Event Log permissions.
builder.Logging.ClearProviders();
builder.Logging.AddConsole();

// Add services to the container.

builder.Services.AddControllers();

builder.Services.AddSignalR();
builder.Services.AddSingleton<IUserIdProvider, JwtUserIdProvider>();

builder.Services.AddCors(options =>
{
    options.AddPolicy("ReactPolicy", policy =>
    {
        // Vite may select another local port when its default port is busy.
        // Accept loopback browser origins for local development (localhost, IPv4, IPv6).
        policy.SetIsOriginAllowed(origin => Uri.TryCreate(origin, UriKind.Absolute, out var uri) && uri.IsLoopback)
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
}

//app.UseHttpsRedirection();

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
