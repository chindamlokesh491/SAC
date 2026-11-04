/** Design tokens shared with the web storefront (see packages/ui-web/styles/tokens.css). */
export const colors = {
  maroon: '#7c1300',
  primary: '#9b1a0b',
  primaryStrong: '#8a0904',
  red: '#c8161d',
  redSoft: '#fdecea',
  saffron: '#e5781c',
  saffronSoft: '#fff1e3',
  gold: '#e9a23b',
  ivory: '#fefcf7',
  cream: '#fcf3ea',
  line: '#ede3d7',
  lineStrong: '#e0d2c1',
  white: '#ffffff',
  ink: '#1d1714',
  ink2: '#3a312c',
  muted: '#6f655d',
  muted2: '#958a80',
  green: '#1d8a3c',
  greenSoft: '#e7f5ea',
  blue: '#1f6fd1',
  blueSoft: '#e8f1fd',
  amber: '#c27803',
  amberSoft: '#fff4dc',
  purple: '#7b3fd0',
  purpleSoft: '#f2eafd',
};

export const fonts = {
  serif: 'SourceSerif4_700Bold',
  serifSemi: 'SourceSerif4_600SemiBold',
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
};

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 };
export const shadow = {
  shadowColor: '#3c1905',
  shadowOpacity: 0.08,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 3 },
  elevation: 2,
};

export const toneColors = {
  success: { bg: colors.greenSoft, fg: colors.green },
  warning: { bg: colors.amberSoft, fg: colors.amber },
  info: { bg: colors.blueSoft, fg: colors.blue },
  danger: { bg: colors.redSoft, fg: colors.red },
  purple: { bg: colors.purpleSoft, fg: colors.purple },
  neutral: { bg: '#f1ede8', fg: colors.muted },
} as const;
