using Ackerman.PaymentBoard.Data;
using Ackerman.PaymentBoard.Models;
using Ackerman.PaymentBoard.Services;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.HttpOverrides;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllersWithViews();
builder.Services.AddAntiforgery(options => options.HeaderName = "X-CSRF-TOKEN");
builder.Services.AddHttpContextAccessor();
builder.Services.AddSingleton<DatabaseFactory>();
builder.Services.AddSingleton<IUserStore, LiteDbUserStore>();
builder.Services.AddSingleton<IAuditStore, LiteDbAuditStore>();
builder.Services.AddSingleton<IApplicationStateStore, LiteDbApplicationStateStore>();
builder.Services.AddSingleton<IPatientStore, LiteDbPatientStore>();
builder.Services.AddSingleton<PatientLedgerGuard>();
builder.Services.AddSingleton<IDocumentStore, LiteDbDocumentStore>();
builder.Services.AddScoped<AuditService>();
builder.Services.AddScoped<UserSecurityService>();
builder.Services.AddSingleton<StateAuditDiffService>();

var cookieMinutes = Math.Max(10, builder.Configuration.GetValue<int?>("Security:CookieMinutes") ?? 30);
var requireHttps = builder.Configuration.GetValue<bool?>("Security:RequireHttps") != false;
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/account/login";
        options.AccessDeniedPath = "/account/denied";
        options.Cookie.Name = "AckermanPaymentBoard.Auth";
        options.Cookie.HttpOnly = true;
        options.Cookie.SecurePolicy = requireHttps ? CookieSecurePolicy.Always : CookieSecurePolicy.SameAsRequest;
        options.Cookie.SameSite = SameSiteMode.Lax;
        options.SlidingExpiration = true;
        options.ExpireTimeSpan = TimeSpan.FromMinutes(cookieMinutes);
        // API calls get a status code instead of the login page, so the board can
        // tell "session expired" apart from "no patients".
        options.Events.OnRedirectToLogin = context =>
        {
            if (context.Request.Path.StartsWithSegments("/api")) context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            else context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (context.Request.Path.StartsWithSegments("/api")) context.Response.StatusCode = StatusCodes.Status403Forbidden;
            else context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });

builder.Services.AddAuthorization();

var app = builder.Build();

// Version 3.3: one-time move from the single whole-board document to one record
// per patient. The old document is left in place, unchanged, as a backup.
using (var scope = app.Services.CreateScope())
{
    var patientStore = scope.ServiceProvider.GetRequiredService<IPatientStore>();
    var legacyBoard = scope.ServiceProvider.GetRequiredService<IApplicationStateStore>();
    var migrationSummary = patientStore.MigrateLegacyBoard(legacyBoard.Get());
    if (migrationSummary is not null)
    {
        scope.ServiceProvider.GetRequiredService<AuditService>()
            .Write("Board migrated to per-patient records", "Board", "main", migrationSummary, "system");
        app.Logger.LogInformation("Payment Board migration: {Summary}", migrationSummary);
    }
}

// Fictional demo patients for development and test sites. Off unless
// Demo:SeedPatients is true, and only ever loaded into an empty board.
if (app.Configuration.GetValue<bool?>("Demo:SeedPatients") == true)
{
    using var scope = app.Services.CreateScope();
    var demoStore = scope.ServiceProvider.GetRequiredService<IPatientStore>();
    var demoCount = DemoPatientSeeder.SeedIfEmpty(demoStore, app.Environment.ContentRootPath, DateTime.Now);
    if (demoCount > 0)
    {
        scope.ServiceProvider.GetRequiredService<AuditService>().Write("Demo patients loaded", "Board", "main",
            $"{demoCount} fictional demo patients (MRNs beginning DEMO-) were added because Demo:SeedPatients is on and the board was empty.", "system");
        app.Logger.LogWarning("Loaded {Count} fictional demo patients because Demo:SeedPatients is on. Turn it off for production.", demoCount);
    }
}

// Development-only convenience account for local UI testing.
// This block runs only when ASPNETCORE_ENVIRONMENT=Development and the
// explicit Development:SeedTestSuperUser switch is enabled. Production
// deployments do not load this account.
if (app.Environment.IsDevelopment() &&
    app.Configuration.GetValue<bool?>("Development:SeedTestSuperUser") == true)
{
    using var scope = app.Services.CreateScope();
    var users = scope.ServiceProvider.GetRequiredService<IUserStore>();
    var security = scope.ServiceProvider.GetRequiredService<UserSecurityService>();
    var audit = scope.ServiceProvider.GetRequiredService<AuditService>();

    var username = app.Configuration["Development:TestSuperUser:Username"]?.Trim();
    var password = app.Configuration["Development:TestSuperUser:Password"];

    if (!string.IsNullOrWhiteSpace(username) &&
        !string.IsNullOrWhiteSpace(password) &&
        users.FindByUsername(username) is null)
    {
        var testUser = new AppUser
        {
            Username = username,
            NormalizedUsername = LiteDbUserStore.Normalize(username),
            Role = Roles.SuperUser,
            IsActive = true,
            MustChangePassword = false,
            CreatedBy = "development seed"
        };
        security.SetPassword(testUser, password);
        users.Upsert(testUser);
        audit.Write("Development Super User seeded", "User", testUser.Id,
            "Local development/test account created.", testUser.Username);
    }
}

app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto
});

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/error");
    app.UseHsts();
}

if (requireHttps)
    app.UseHttpsRedirection();

app.UseStaticFiles();
app.UseRouting();
app.UseAuthentication();
app.UseMiddleware<AccountStateMiddleware>();
app.UseAuthorization();
app.MapControllers();

app.MapGet("/", (HttpContext context, IUserStore users, IConfiguration config) =>
{
    if (users.Count() == 0 && config.GetValue<bool?>("Security:AllowFirstRunSetup") == true)
        return Results.Redirect("/setup");
    return context.User.Identity?.IsAuthenticated == true
        ? Results.Redirect("/app")
        : Results.Redirect("/account/login");
});

app.Run();
