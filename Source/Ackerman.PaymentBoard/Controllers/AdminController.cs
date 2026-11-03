using Ackerman.PaymentBoard.Models;
using Ackerman.PaymentBoard.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Ackerman.PaymentBoard.Controllers;

[Authorize(Roles = Roles.SuperUser), Route("admin")]
public sealed class AdminController : Controller
{
    private readonly IUserStore _users;
    private readonly IAuditStore _auditStore;
    private readonly AuditService _audit;
    private readonly UserSecurityService _security;

    public AdminController(IUserStore users, IAuditStore auditStore, AuditService audit, UserSecurityService security)
    {
        _users = users;
        _auditStore = auditStore;
        _audit = audit;
        _security = security;
    }

    [HttpGet("")]
    public IActionResult Index()
    {
        ViewBag.Audit = _auditStore.Recent(100);
        return View(_users.List());
    }

    [HttpGet("create")]
    public IActionResult Create() => View(new CreateUserViewModel());

    [ValidateAntiForgeryToken, HttpPost("create")]
    public IActionResult Create(CreateUserViewModel model)
    {
        if (model.Role != Roles.StandardUser && model.Role != Roles.SuperUser)
            ModelState.AddModelError(nameof(model.Role), "Invalid role.");
        if (_users.FindByUsername(model.Username) is not null)
            ModelState.AddModelError(nameof(model.Username), "That username already exists.");
        if (!ModelState.IsValid) return View(model);

        var user = new AppUser
        {
            Username = model.Username.Trim(),
            NormalizedUsername = LiteDbUserStore.Normalize(model.Username),
            Role = model.Role,
            IsActive = true,
            MustChangePassword = true,
            CreatedBy = User.Identity?.Name ?? "Super User"
        };
        _security.SetPassword(user, model.TemporaryPassword);
        _users.Upsert(user);
        _audit.Write("User created", "User", user.Id, $"Role={user.Role}; must change password on first login.");
        TempData["Message"] = $"Created {user.Username}. The temporary password must be changed at first login.";
        return RedirectToAction(nameof(Index));
    }

    [ValidateAntiForgeryToken, HttpPost("reset-password")]
    public IActionResult ResetPassword(ResetPasswordViewModel model)
    {
        var user = _users.FindById(model.UserId);
        if (user is null) return NotFound();
        if (!ModelState.IsValid)
        {
            TempData["Error"] = "Temporary password must be at least 5 characters.";
            return RedirectToAction(nameof(Index));
        }
        _security.SetPassword(user, model.TemporaryPassword);
        user.MustChangePassword = true;
        user.FailedLoginCount = 0;
        user.LockoutEndUtc = null;
        _users.Upsert(user);
        _audit.Write("Password reset by Super User", "User", user.Id, "Temporary password issued; change required on next login.");
        TempData["Message"] = $"Password reset for {user.Username}.";
        return RedirectToAction(nameof(Index));
    }

    [ValidateAntiForgeryToken, HttpPost("toggle-active/{id}")]
    public IActionResult ToggleActive(string id)
    {
        var user = _users.FindById(id);
        if (user is null) return NotFound();
        if (string.Equals(user.Username, User.Identity?.Name, StringComparison.OrdinalIgnoreCase) && user.IsActive)
        {
            TempData["Error"] = "You cannot disable your own account.";
            return RedirectToAction(nameof(Index));
        }
        user.IsActive = !user.IsActive;
        _users.Upsert(user);
        _audit.Write(user.IsActive ? "User enabled" : "User disabled", "User", user.Id);
        return RedirectToAction(nameof(Index));
    }

    [ValidateAntiForgeryToken, HttpPost("set-role/{id}")]
    public IActionResult SetRole(string id, string role)
    {
        var user = _users.FindById(id);
        if (user is null) return NotFound();
        if (role != Roles.StandardUser && role != Roles.SuperUser) return BadRequest();
        if (string.Equals(user.Username, User.Identity?.Name, StringComparison.OrdinalIgnoreCase) && role != Roles.SuperUser)
        {
            TempData["Error"] = "You cannot remove your own Super User access.";
            return RedirectToAction(nameof(Index));
        }
        var oldRole = user.Role;
        user.Role = role;
        _users.Upsert(user);
        _audit.Write("User role changed", "User", user.Id, $"{oldRole} -> {role}");
        return RedirectToAction(nameof(Index));
    }
}
