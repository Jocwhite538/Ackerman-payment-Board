using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Ackerman.PaymentBoard.Services;

/// <summary>
/// Server-side rules for the payment ledger. The browser sends the whole patient,
/// but recorded payments and adjustments are append-only:
/// - a recorded entry is always stored exactly as it was first recorded;
/// - an attempt to change or delete one is refused (the stored entry is kept) and reported;
/// - new entries are stamped with the signed-in user and the server time.
/// Corrections are made the way the board already makes them: by recording a
/// reversal, refund, or correction entry.
/// </summary>
public sealed class PatientLedgerGuard
{
    // Fields that define what a recorded transaction is.
    private static readonly string[] PaymentFields =
    {
        "type", "amount", "date", "responsibilityParty", "installmentId",
        "relatedTransactionId", "method", "officeSite", "appliesToPlan", "note", "username"
    };

    private static readonly string[] AdjustmentFields = { "type", "amount", "date", "note" };

    private static readonly string[] StampFields = { "recordedBy", "recordedAtUtc" };

    public const int MaxMrnLength = 64;

    private readonly ILogger<PatientLedgerGuard> _logger;

    public PatientLedgerGuard(ILogger<PatientLedgerGuard> logger) => _logger = logger;

    public PatientPrepareResult Prepare(string patientId, string? storedJson, JsonElement incoming, string username, DateTime nowUtc)
    {
        try
        {
            return PrepareCore(patientId, storedJson, incoming, username, nowUtc);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or JsonException or FormatException)
        {
            // For example, the same property name twice in one object.
            _logger.LogWarning(ex, "Patient {PatientId} save refused: the data could not be processed.", patientId);
            return PatientPrepareResult.Fail("The patient data is not in the expected format.");
        }
    }

    private PatientPrepareResult PrepareCore(string patientId, string? storedJson, JsonElement incoming, string username, DateTime nowUtc)
    {
        if (incoming.ValueKind != JsonValueKind.Object) return PatientPrepareResult.Fail("Patient must be a JSON object.");

        if (JsonNode.Parse(incoming.GetRawText()) is not JsonObject next)
            return PatientPrepareResult.Fail("Patient must be a JSON object.");

        if (!string.Equals(Text(next, "id"), patientId, StringComparison.Ordinal))
            return PatientPrepareResult.Fail("The patient id in the request does not match the address.");

        var stored = storedJson is null ? null : JsonNode.Parse(storedJson) as JsonObject;
        var stamp = nowUtc.ToString("o", CultureInfo.InvariantCulture);
        var warnings = new List<string>();

        var error = GuardEntries(stored, next, "payments", "payment", PaymentFields, username, stamp, isPayment: true, warnings)
                    ?? GuardEntries(stored, next, "adjustments", "adjustment", AdjustmentFields, username, stamp, isPayment: false, warnings);
        if (error is not null) return PatientPrepareResult.Fail(error);

        var mrn = Text(next, "mrn").Trim().ToUpperInvariant();
        if (mrn.Length > MaxMrnLength) return PatientPrepareResult.Fail($"The MRN can be at most {MaxMrnLength} characters.");

        var prepared = new PreparedPatient(next.ToJsonString(), Text(next, "name").Trim(), mrn);
        return new PatientPrepareResult(prepared, null, warnings);
    }

    private static string? GuardEntries(
        JsonObject? stored,
        JsonObject next,
        string property,
        string label,
        string[] lockedFields,
        string username,
        string stamp,
        bool isPayment,
        List<string> warnings)
    {
        var storedEntries = Entries(stored, property);
        var incomingNode = next[property];
        if (incomingNode is not null && incomingNode is not JsonArray)
            return $"The {label} list is not in the expected format.";

        var entries = incomingNode as JsonArray;
        if (entries is null)
        {
            if (storedEntries.Count == 0) return null;
            entries = new JsonArray();
            next[property] = entries;
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < entries.Count; i++)
        {
            if (entries[i] is not JsonObject entry) return $"A {label} entry is not in the expected format.";
            var id = Text(entry, "id");
            if (string.IsNullOrWhiteSpace(id)) return $"Every {label} entry needs an id.";
            if (!seen.Add(id)) return $"The same {label} entry appears twice.";

            if (storedEntries.TryGetValue(id, out var original))
            {
                var changed = lockedFields.Any(field => !SameValue(original[field], entry[field]));
                entries[i] = KeepRecorded(original, entry);
                if (changed)
                    warnings.Add($"A change to a recorded {label} was not saved. Recorded {label}s can't be edited; record a reversal or correction instead.");
                continue;
            }

            // A new entry: validate the amount and stamp who recorded it and when.
            if (!IsNonNegativeNumber(entry["amount"])) return $"A new {label} needs an amount of $0.00 or more.";
            foreach (var field in StampFields) entry.Remove(field);
            if (isPayment) entry["username"] = username;
            entry["recordedBy"] = username;
            entry["recordedAtUtc"] = stamp;
        }

        var missing = storedEntries.Keys.Where(id => !seen.Contains(id)).ToList();
        foreach (var id in missing) entries.Add(storedEntries[id].DeepClone());
        if (missing.Count > 0)
            warnings.Add($"{missing.Count} recorded {label}{(missing.Count == 1 ? " was" : "s were")} not removed. Recorded {label}s can't be deleted; record a reversal or correction instead.");

        return null;
    }

    /// <summary>
    /// The stored entry always wins. Fields the stored entry never had (for example a
    /// field added by a newer version of the board) may be filled in from the browser,
    /// except the server stamps, which only the server writes.
    /// </summary>
    private static JsonObject KeepRecorded(JsonObject original, JsonObject incoming)
    {
        var result = (JsonObject)original.DeepClone();
        foreach (var (key, value) in incoming)
        {
            if (result.ContainsKey(key) || StampFields.Contains(key)) continue;
            result[key] = value?.DeepClone();
        }
        return result;
    }

    private static Dictionary<string, JsonObject> Entries(JsonObject? patient, string property)
    {
        var result = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        if (patient?[property] is not JsonArray array) return result;
        foreach (var node in array)
        {
            if (node is not JsonObject entry) continue;
            var id = Text(entry, "id");
            if (!string.IsNullOrWhiteSpace(id)) result[id] = entry;
        }
        return result;
    }

    private static bool SameValue(JsonNode? stored, JsonNode? incoming)
    {
        // A field the stored entry never had can be filled in; that is not a change.
        if (stored is null) return true;
        if (incoming is null) return false;
        if (stored is JsonValue storedValue && incoming is JsonValue incomingValue &&
            storedValue.TryGetValue<decimal>(out var storedNumber) &&
            incomingValue.TryGetValue<decimal>(out var incomingNumber))
        {
            return storedNumber == incomingNumber;
        }
        return string.Equals(stored.ToJsonString(), incoming.ToJsonString(), StringComparison.Ordinal);
    }

    private static bool IsNonNegativeNumber(JsonNode? node)
        => node is JsonValue value && value.TryGetValue<decimal>(out var number) && number >= 0;

    private static string Text(JsonObject? obj, string property)
        => obj?[property] is JsonValue value && value.TryGetValue<string>(out var text) ? text ?? "" : "";
}
