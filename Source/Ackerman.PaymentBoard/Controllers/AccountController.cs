using System.Security.Claims;
using Ackerman.PaymentBoard.Models;
using Ackerman.PaymentBoard.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Identity;

namespace Ackerman.PaymentBoard.Controllers;

[Route("account")]
public sealed class AccountController : Controller
{
    private readonly IUserStore _users;
    private readonly UserSecurityService _security;
    private readonly AuditService _audit;

    public AccountController(IUserStore users, UserSecurityService security, AuditService audit)
    {
        _users = users;
        _security = security;
        _audit = audit;
    }

    [AllowAnonymous, HttpGet("login")]
    public IActionResult Login(string? returnUrl = null)
    {
        if (User.Identity?.IsAuthenticated == true) return Redirect("/app");
        return View(new LoginViewModel { ReturnUrl = returnUrl });
    }

    [AllowAnonymous, ValidateAntiForgeryToken, HttpPost("login")]
    public async Task<IActionResult> Login(LoginViewModel model)
    {
        if (!ModelState.IsValid) return View(model);

        var user = _users.FindByUsername(model.Username);
        if (user is null || !user.IsActive)
        {
            ModelState.AddModelError("", "Invalid username or password.");
            _audit.Write("Login failed", "User", model.Username, "Unknown or disabled user.", model.Username);
            return View(model);
        }

        if (_security.IsLockedOut(user))
        {
            ModelState.AddModelError("", "This account is temporarily locked. Please try again later or contact a Super User.");
            _audit.Write("Login blocked", "User", user.Id, "Account is locked out.", user.Username);
            return View(model);
        }

        var verification = _security.Verify(user, model.Password);
        if (verification == PasswordVerificationResult.Failed)
        {
            _security.RecordFailure(user);
            ModelState.AddModelError("", "Invalid username or password.");
            _audit.Write("Login failed", "User", user.Id, "Incorrect password.", user.Username);
            return View(model);
        }

        if (verification == PasswordVerificationResult.SuccessRehashNeeded)
        {
            _security.SetPassword(user, model.Password);
            _users.Upsert(user);
        }

        _security.RecordSuccess(user);
        await SignInAsync(user);
        _audit.Write("Login succeeded", "User", user.Id, "", user.Username);

        if (user.MustChangePassword) return RedirectToAction(nameof(ChangePassword));
        if (!string.IsNullOrWhiteSpace(model.ReturnUrl) && Url.IsLocalUrl(model.ReturnUrl)) return LocalRedirect(model.ReturnUrl);
        return Redirect("/app");
    }

    [Authorize, HttpGet("change-password")]
    public IActionResult ChangePassword() => View(new ChangePasswordViewModel());

    [Authorize, ValidateAntiForgeryToken, HttpPost("change-password")]
    public async Task<IActionResult> ChangePassword(ChangePasswordViewModel model)
    {
        var user = _users.FindByUsername(User.Identity?.Name ?? "");
        if (user is null) return RedirectToAction(nameof(Login));
        if (!ModelState.IsValid) return View(model);
        if (_security.Verify(user, model.CurrentPassword) == PasswordVerificationResult.Failed)
        {
            ModelState.AddModelError(nameof(model.CurrentPassword), "Current password is incorrect.");
            return View(model);
        }

        _security.SetPassword(user, model.NewPassword);
        user.MustChangePassword = false;
        user.FailedLoginCount = 0;
        user.LockoutEndUtc = null;
        _users.Upsert(user);
        await SignInAsync(user);
        _audit.Write("Password changed", "User", user.Id);
        TempData["Message"] = "Password changed successfully.";
        return Redirect("/app");
    }

    [Authorize, ValidateAntiForgeryToken, HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        _audit.Write("Logout", "User", User.FindFirstValue(ClaimTypes.NameIdentifier) ?? "");
        await HttpContext.SignOutAsync();
        return RedirectToAction(nameof(Login));
    }

    [AllowAnonymous, HttpGet("denied")]
    public IActionResult Denied() => View();

    private async Task SignInAsync(AppUser user)
    {
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, user.Id),
            new(ClaimTypes.Name, user.Username),
            new(ClaimTypes.Role, user.Role)
        };
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme));
        await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal,
            new AuthenticationProperties { IsPersistent = false, AllowRefresh = true });
    }
}
