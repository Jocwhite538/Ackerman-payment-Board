using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Ackerman.PaymentBoard.Controllers;

[Authorize, Route("app")]
public sealed class AppController : Controller
{
    private readonly IWebHostEnvironment _environment;
    public AppController(IWebHostEnvironment environment) => _environment = environment;

    [HttpGet("")]
    public IActionResult Board() => Page("index.html");

    [HttpGet("analytics")]
    public IActionResult Analytics() => Page("analytics.html");

    [HttpGet("completed")]
    public IActionResult Completed() => Page("completed.html");

    private IActionResult Page(string name)
    {
        var path = Path.Combine(_environment.ContentRootPath, "AppPages", name);
        if (!System.IO.File.Exists(path)) return NotFound();
        // Always fetch the page fresh so browsers pick up new script versions after an upgrade.
        Response.Headers.CacheControl = "no-store";
        return PhysicalFile(path, "text/html; charset=utf-8");
    }
}
