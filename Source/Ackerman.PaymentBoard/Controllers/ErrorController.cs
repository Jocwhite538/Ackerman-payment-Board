using Microsoft.AspNetCore.Mvc;

namespace Ackerman.PaymentBoard.Controllers;

public sealed class ErrorController : Controller
{
    [Route("error")]
    public IActionResult Index() => View("~/Views/Shared/Error.cshtml");
}
