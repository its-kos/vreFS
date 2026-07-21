import { LabIcon } from '@jupyterlab/ui-components';

/**
 * vreFS icon — a mountain peak reflected in a lake, evoking
 * both "glacier" (the project's working name) and a data lake.
 * Designed on a 24x24 grid to match JupyterLab's sidebar icon size.
 */
const vreFSSvgStr = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
  <!-- Mountain peak -->
  <path
    d="M3 17 L8 8 L11 13 L13 10 L21 17 Z"
    fill="#4A90D9"
    stroke="#2C6FA8"
    stroke-width="0.6"
    stroke-linejoin="round"
  />
  <!-- Snow cap -->
  <path
    d="M13 10 L14.5 12.5 L15.5 11 L17 13 L21 17 L13 17 Z"
    fill="#B8D9F5"
    stroke="none"
  />
  <path
    d="M8 8 L9.5 10.5 L11 8.5 L11 13 L3 17 Z"
    fill="#7AB3E0"
    stroke="none"
  />
  <!-- Lake / reflection ripples -->
  <path
    d="M2 19 Q6 17.5 12 19 Q18 20.5 22 19"
    fill="none"
    stroke="#2C6FA8"
    stroke-width="1.2"
    stroke-linecap="round"
  />
  <path
    d="M4 21 Q8 19.5 12 21 Q16 22.5 20 21"
    fill="none"
    stroke="#4A90D9"
    stroke-width="0.9"
    stroke-linecap="round"
  />
</svg>
`;

export const vreFSIcon = new LabIcon({
  name: 'vrefs:lake-icon',
  svgstr: vreFSSvgStr
});
