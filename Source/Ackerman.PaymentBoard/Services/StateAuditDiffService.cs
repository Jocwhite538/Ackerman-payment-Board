using System.Globalization;
using System.Text.Json;

namespace Ackerman.PaymentBoard.Services;

public sealed record StateAuditChange(string Action, string PatientId, string Details);

/// <summary>
/// Describes what changed in one patient save, for the audit history.
/// Money changes are written out with amounts; free-text fields (notes) are
/// reported as changed without copying their text into the audit log.
/// </summary>
public sealed class StateAuditDiffService
{
    private static readonly CultureInfo Money = CultureInfo.GetCultureInfo("en-US");

    public StateAuditChange ComparePatient(string patientId, string? previousJson, string nextJson)
    {
        using var nextDocument = JsonDocument.Parse(nextJson);
        var current = nextDocument.RootElement;

        if (previousJson is null)
        {
            var created = new List<string> { $"{DisplayName(current)} added" };
            var responsibility = Number(current, "responsibility");
            if (responsibility is not null) created.Add($"total responsibility {Currency(responsibility.Value)}");
            created.AddRange(NewEntries(default, current, "payments", isPayment: true));
            created.AddRange(NewEntries(default, current, "adjustments", isPayment: false));
            return new StateAuditChange("Patient added", patientId, string.Join("; ", created));
        }

        using var previousDocument = JsonDocument.Parse(previousJson);
        var old = previousDocument.RootElement;
        var details = new List<string>();

        AddIfChanged(old, current, "name", "name", details);
        AddIfChanged(old, current, "mrn", "MRN", details);
        AddIfChanged(old, current, "location", "treatment site", details);
        AddIfChanged(old, current, "insurance", "insurance", details);
        AddIfChanged(old, current, "treatments", "treatments", details);

        var oldResponsibility = Number(old, "responsibility");
        var newResponsibility = Number(current, "responsibility");
        if (oldResponsibility != newResponsibility)
            details.Add($"total responsibility {Currency(oldResponsibility)} -> {Currency(newResponsibility)}");

        AddIfChanged(old, current, "arrangement", "arrangement", details);
        AddIfChanged(old, current, "collectionDate", "collection date", details);
        AddIfChanged(old, current, "paymentPlan", "payment schedule", details);
        AddIfChanged(old, current, "statusNote", "status note", details);
        AddIfChanged(old, current, "notes", "finance note", details);

        var wasArchived = Bool(old, "archived");
        var isArchived = Bool(current, "archived");
        if (!wasArchived && isArchived) details.Add($"completed ({Text(current, "completionReason")})");
        if (wasArchived && !isArchived) details.Add("restored to the active board");

        details.AddRange(NewEntries(old, current, "payments", isPayment: true));
        details.AddRange(NewEntries(old, current, "adjustments", isPayment: false));

        var summary = details.Count > 0 ? string.Join("; ", details) : "activity or timeline updated";
        return new StateAuditChange("Patient updated", patientId, $"{DisplayName(current)}: {summary}");
    }

    private static IEnumerable<string> NewEntries(JsonElement old, JsonElement current, string property, bool isPayment)
    {
        var existing = new HashSet<string>(StringComparer.Ordinal);
        if (old.ValueKind == JsonValueKind.Object && old.TryGetProperty(property, out var oldEntries) && oldEntries.ValueKind == JsonValueKind.Array)
            foreach (var entry in oldEntries.EnumerateArray()) existing.Add(Text(entry, "id"));

        if (!current.TryGetProperty(property, out var entries) || entries.ValueKind != JsonValueKind.Array) yield break;
        foreach (var entry in entries.EnumerateArray())
        {
            if (existing.Contains(Text(entry, "id"))) continue;
            var amount = Currency(Number(entry, "amount"));
            var type = Text(entry, "type");
            if (isPayment)
            {
                var party = Text(entry, "responsibilityParty") == "UF" ? "UF" : "ACC";
                yield return $"{(string.IsNullOrEmpty(type) ? "Payment" : type)} recorded {amount} {party} ({Text(entry, "method")}, {Text(entry, "date")})";
            }
            else
            {
                yield return $"{(string.IsNullOrEmpty(type) ? "Adjustment" : type)} recorded {amount} ({Text(entry, "date")})";
            }
        }
    }

    private static string DisplayName(JsonElement item)
        => string.IsNullOrWhiteSpace(Text(item, "name")) ? "Patient" : Text(item, "name");

    private static void AddIfChanged(JsonElement old, JsonElement current, string property, string label, List<string> details)
    {
        if (!string.Equals(Raw(old, property), Raw(current, property), StringComparison.Ordinal)) details.Add($"{label} changed");
    }

    private static string Currency(decimal? value) => value is null ? "(none)" : value.Value.ToString("C", Money);

    private static decimal? Number(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object &&
           element.TryGetProperty(property, out var value) &&
           value.ValueKind == JsonValueKind.Number &&
           value.TryGetDecimal(out var number)
            ? number
            : null;

    private static bool Bool(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object &&
           element.TryGetProperty(property, out var value) &&
           value.ValueKind == JsonValueKind.True;

    private static string Text(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object &&
           element.TryGetProperty(property, out var value) &&
           value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? ""
            : "";

    private static string Raw(JsonElement element, string property)
        => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value) ? value.GetRawText() : "null";
}
