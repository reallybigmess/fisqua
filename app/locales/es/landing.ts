/**
 * Traducciones al español — namespace `landing`
 *
 * This locale namespace carries las cadenas que alimentan la página
 * de aterrizaje del ápice (`app/routes/_index.tsx`) y el selector de
 * espacio de trabajo. Cada valor está fijado palabra por palabra en
 * `32-LANDING-COPY.md` y en la pasada de diseño del 2026-05-02; no
 * parafrasees, no retraduzcas y no abrevies sin volver a abrir ese
 * documento. La cifra de versión en `hero.eyebrow` ("FISQUA · v0.4")
 * se actualiza a mano al cierre del hito junto con `footer.version`.
 *
 * El valor `context.paragraph` se consume con `<Trans>`: el `<em>`
 * alrededor de *serverless* renderiza en cursiva y los `<strong>`
 * alrededor de los estándares (ISAD(G), DACS, RAD) y los nombres
 * institucionales (AMPL, Neogranadina) renderizan en seminegrita.
 *
 * @version v0.4.0
 */
export default {
  header: {
    brand: "Fisqua",
    lang_toggle_label: "Cambiar idioma",
    lang_en: "EN",
    lang_es: "ES",
  },
  hero: {
    eyebrow: "FISQUA · v0.4",
    tagline:
      "Una plataforma colaborativa y de código abierto para la catalogación y gestión de archivos.",
  },
  picker: {
    label: "Espacio de trabajo",
    placeholder: "tu-espacio",
    suffix: ".fisqua.org",
    submit: "Continuar",
    submitting: "Abriendo el espacio de trabajo…",
    helper: "Escribe el nombre de tu espacio de trabajo.",
    error: {
      empty: "Ingresa el nombre del espacio de trabajo.",
      shape:
        "Los nombres de espacios de trabajo solo usan letras minúsculas, números y guiones, y empiezan con una letra.",
      notFound:
        'No tenemos un espacio de trabajo llamado "{{slug}}". Revisa la ortografía e inténtalo de nuevo.',
    },
  },
  context: {
    eyebrow: "Acerca de Fisqua",
    paragraph:
      'Fisqua, del verbo muisca "recoger cosas desperdigadas", es una plataforma de código abierto para catalogación y gestión archivística. Funciona sobre infraestructura <em>serverless</em> ligera y abre la descripción al trabajo colaborativo de comunidades. Admite los estándares <strong>ISAD(G)</strong>, <strong>DACS</strong> y <strong>RAD</strong>, y exporta todos los datos en formatos abiertos. La desarrolla el <strong>Laboratorio de Archivos, Memoria y Preservación (AMPL)</strong> de la Universidad de California, Santa Bárbara, y <strong>Neogranadina</strong>.',
  },
  footer: {
    version: "Fisqua v0.4",
    license: "Código abierto",
    about: "Acerca de",
    source: "Código fuente",
  },
  meta: {
    title: "Fisqua",
    description:
      "Plataforma de código abierto para la catalogación y gestión de archivos, desarrollada en el Laboratorio de Archivos, Memoria y Preservación (AMPL) de la Universidad de California, Santa Bárbara, y en Neogranadina.",
  },
} as const;

// @version v0.4.0
