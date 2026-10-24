using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

var relaxed = new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
var rows = new List<object>();
// Every UTF-16 code unit on its own. Lone surrogates are included on purpose.
for (int cu = 0; cu <= 0xFFFF; cu++)
{
    var s = ((char)cu).ToString();
    var json = JsonSerializer.Serialize(s, relaxed); // includes the surrounding quotes
    rows.Add(new { cu, json = json.Substring(1, json.Length - 2) });
}
// Astral pairs, plus a few well-formed sequences.
foreach (var s in new[] { "\U0001F600", "\U0001F600x", "a\U00010000b", "\U0010FFFF" })
{
    var json = JsonSerializer.Serialize(s, relaxed);
    rows.Add(new { cu = -1, json = json.Substring(1, json.Length - 2), astral = s });
}
Console.WriteLine(JsonSerializer.Serialize(rows, new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
