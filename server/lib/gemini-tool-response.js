// A tool's answer as Gemini takes it (TraceApps/lifttrace#147). The same
// file in every Trace app, and in the server of the ones that talk to
// Gemini from there: change one, change them all.
//
// Gemini's FunctionResponse.response is "the function response in JSON
// object format" (a protobuf Struct, ai.google.dev/api/generate-content#FunctionResponse).
// A list there is refused with "Proto field is not repeating, cannot start
// list", and a string, number, true/false or null is no object either. So
// anything but an object goes in one under "result", one of the keys the
// same page suggests; an object (an { error } one too) goes as it is.

/** The `functionResponse.response` for a tool's result. */
export function geminiToolResponse(result) {
  const object = result !== null && typeof result === 'object' && !Array.isArray(result) && typeof result.toJSON !== 'function';
  return object ? result : { result: result === undefined ? null : result };
}
