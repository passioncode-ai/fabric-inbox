/** B-178: the arrival safety check is on unless the server's SAFETY_CHECK says off. */
export const safetyOn = (env: { SAFETY_CHECK?: string }) => (env.SAFETY_CHECK ?? "").toLowerCase() !== "off";
