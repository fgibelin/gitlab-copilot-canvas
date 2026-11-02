const SHIM = new URL("./shim-sdk.mjs", import.meta.url).href;
const WRAP = new URL("./instance-wrapper.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
    if (specifier === "@github/copilot-sdk/extension") return { url: SHIM, shortCircuit: true };
    if (specifier === "./instance.mjs" && context.parentURL === new URL("../../canvas/extension.mjs", import.meta.url).href) return { url: WRAP, shortCircuit: true };
    return next(specifier, context);
}
