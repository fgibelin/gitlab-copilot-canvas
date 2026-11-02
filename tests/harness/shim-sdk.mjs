// Stand-in for @github/copilot-sdk/extension: records what the extension declares so tests can drive it directly.
export class CanvasError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "CanvasError";
        this.code = code;
    }
}

export const createCanvas = (definition) => definition;

export const captured = { config: null, session: null, logs: [] };

export async function joinSession(config) {
    captured.config = config;
    captured.session = {
        sessionId: "test-session",
        workspacePath: undefined,
        log: async (message, options) => {
            captured.logs.push({ message, ...options });
        },
    };
    return captured.session;
}
