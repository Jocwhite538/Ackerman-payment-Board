using System.ComponentModel.DataAnnotations;

namespace Ackerman.PaymentBoard.Models;

public sealed class LoginViewModel
{
    [Required]
    public string Username { get; set; } = "";

    [Required, DataType(DataType.Password)]
    public string Password { get; set; } = "";

    public string? ReturnUrl { get; set; }
}

public sealed class ChangePasswordViewModel
{
    [Required, DataType(DataType.Password)]
    public string CurrentPassword { get; set; } = "";

    [Required, DataType(DataType.Password), MinLength(5)]
    public string NewPassword { get; set; } = "";

    [Required, DataType(DataType.Password), Compare(nameof(NewPassword))]
    public string ConfirmPassword { get; set; } = "";
}

public sealed class FirstRunSetupViewModel
{
    [Required]
    public string Username { get; set; } = "";

    [Required, DataType(DataType.Password), MinLength(5)]
    public string Password { get; set; } = "";

    [Required, DataType(DataType.Password), Compare(nameof(Password))]
    public string ConfirmPassword { get; set; } = "";
}

public sealed class CreateUserViewModel
{
    [Required]
    public string Username { get; set; } = "";

    [Required, DataType(DataType.Password), MinLength(5)]
    public string TemporaryPassword { get; set; } = "";

    [Required]
    public string Role { get; set; } = Roles.StandardUser;
}

public sealed class ResetPasswordViewModel
{
    [Required]
    public string UserId { get; set; } = "";

    [Required, DataType(DataType.Password), MinLength(5)]
    public string TemporaryPassword { get; set; } = "";
}
