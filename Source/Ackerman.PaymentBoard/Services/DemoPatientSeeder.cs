using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Ackerman.PaymentBoard.Services;

/// <summary>
/// Loads the fictional demo patients in DemoData/demo-patients.json, but only when
/// Demo:SeedPatients is true AND the board has no patients at all. It never adds
/// demo patients to a board that already holds data. Demo IDs start with "demo-"
/// and MRNs with "DEMO-".
///
/// The file's dates are relative to its anchorDate. They are moved forward so the
/// demo board always looks current (some payments due today, some overdue, and so on).
/// </summary>
public static class DemoPatientSeeder
{
    public const string RelativePath = "DemoData/demo-patients.json";
    private const string SeedUser = "Demo data";
    private static readonly Regex LeadingIsoDate = new(@"^\d{4}-\d{2}-\d{2}", RegexOptions.CultureInvariant);

    public static int SeedIfEmpty(IPatientStore store, string contentRootPath, DateTime today)
    {
        if (store.List().Count > 0) return 0;

        var path = Path.Combine(contentRootPath, RelativePath.Replace('/', Path.DirectorySeparatorChar));
        if (!File.Exists(path)) throw new FileNotFoundException("Demo:SeedPatients is on, but the demo patient file is missing.", path);

        var root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject
                   ?? throw new InvalidOperationException("The demo patient file is not a JSON object.");
        var anchorText = root["anchorDate"] is JsonValue anchorValue && anchorValue.TryGetValue<string>(out var anchorString)
            ? anchorString ?? ""
            : "";
        if (!DateTime.TryParseExact(anchorText, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var anchor))
            throw new InvalidOperationException("The demo patient file needs an anchorDate (yyyy-MM-dd).");
        var shiftDays = (today.Date - anchor.Date).Days;

        var saved = 0;
        foreach (var node in (root["patients"] as JsonArray ?? new JsonArray()).ToList())
        {
            if (node is not JsonObject patient) continue;
            ShiftDates(patient, shiftDays);
            var id = Text(patient, "id");
            if (!id.StartsWith("demo-", StringComparison.Ordinal) || !Text(patient, "mrn").StartsWith("DEMO-", StringComparison.Ordinal))
                throw new InvalidOperationException($"Demo patient '{id}' must have an id starting 'demo-' and an MRN starting 'DEMO-'.");

            var prepared = new PreparedPatient(patient.ToJsonString(), Text(patient, "name").Trim(), Text(patient, "mrn").Trim().ToUpperInvariant());
            var result = store.Save(id, 0, SeedUser, _ => new PatientPrepareResult(prepared, null, Array.Empty<string>()));
            if (result.Status == PatientSaveStatus.Saved) saved++;
        }
        return saved;
    }

    private static void ShiftDates(JsonNode? node, int days)
    {
        if (days == 0) return;
        switch (node)
        {
            case JsonObject obj:
                foreach (var key in obj.Select(property => property.Key).ToList())
                {
                    if (TryShift(obj[key], days, out var shifted)) obj[key] = shifted;
                    else ShiftDates(obj[key], days);
                }
                break;
            case JsonArray array:
                for (var i = 0; i < array.Count; i++)
                {
                    if (TryShift(array[i], days, out var shifted)) array[i] = shifted;
                    else ShiftDates(array[i], days);
                }
                break;
        }
    }

    // "2026-11-03" or "2026-11-03T10:15:00": move the date part, keep the rest.
    private static bool TryShift(JsonNode? node, int days, out string shifted)
    {
        shifted = "";
        if (node is not JsonValue value || !value.TryGetValue<string>(out var text) || text is null) return false;
        var match = LeadingIsoDate.Match(text);
        if (!match.Success ||
            !DateTime.TryParseExact(match.Value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            return false;
        shifted = date.AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + text[match.Length..];
        return true;
    }

    private static string Text(JsonObject obj, string property)
        => obj[property] is JsonValue value && value.TryGetValue<string>(out var text) ? text ?? "" : "";
}
