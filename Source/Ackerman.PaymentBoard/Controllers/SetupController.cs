using Ackerman.PaymentBoard.Models;
using Ackerman.PaymentBoard.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Ackerman.PaymentBoard.Controllers;

[AllowAnonymous, Route("setup")]
public sealed class SetupController : Controller
{
    private readonly IUserStore _users;
    private readonly UserSecurityService _security;
    private readonly AuditService _audit;
    private readonly IConfiguration _configuration;

    public SetupController(IUserStore users, UserSecurityService security, AuditService audit, IConfiguration configuration)
    {
        _users = users;
        _security = security;
        _audit = audit;
        _configuration = configuration;
    }

    [HttpGet]
    public IActionResult Index()
    {
        if (_configuration.GetValue<bool?>("Security:AllowFirstRunSetup") != true || _users.Count() > 0)
            return Redirect("/account/login");
        return View(new FirstRunSetupViewModel());
    }

    [ValidateAntiForgeryToken, HttpPost]
    public IActionResult Index(FirstRunSetupViewModel model)
    {
        if (_configuration.GetValue<bool?>("Security:AllowFirstRunSetup") != true || _users.Count() > 0)
            return Redirect("/account/login");
        if (!ModelState.IsValid) return View(model);

        var user = new AppUser
        {
            Username = model.Username.Trim(),
            NormalizedUsername = LiteDbUserStore.Normalize(model.Username),
            Role = Roles.SuperUser,
            IsActive = true,
            MustChangePassword = false,
            CreatedBy = "first-run setup"
        };
        _security.SetPassword(user, model.Password);
        _users.Upsert(user);
        _audit.Write("Initial Super User created", "User", user.Id, "First-run setup completed.", user.Username);
        return Redirect("/account/login");
    }
}
