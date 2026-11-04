import { formatPhone, normalizeIndianMobile } from '@sac/shared';
import { StackActions, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../api';
import { Body, Button, ScreenHeader, Title } from '../components/ui';
import { GOOGLE_ANDROID_CLIENT_ID, GOOGLE_WEB_CLIENT_ID } from '../config';
import type { RootStackParamList } from '../navigation-types';
import { errorMessage, useSession } from '../session';
import { colors, fonts } from '../theme';

WebBrowser.maybeCompleteAuthSession();

/** Rendered only when Google client IDs are configured for this build. */
function GoogleSignIn({ onToken }: { onToken: (idToken: string) => void }) {
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({ androidClientId: GOOGLE_ANDROID_CLIENT_ID, webClientId: GOOGLE_WEB_CLIENT_ID });
  useEffect(() => {
    if (response?.type === 'success' && response.params.id_token) onToken(response.params.id_token);
  }, [response, onToken]);
  return <Button variant="ghost" title="Continue with Google" disabled={!request} onPress={() => void promptAsync()} />;
}

export function LoginScreen() {
  const navigation = useNavigation();
  const route = useRoute<RouteProp<RootStackParamList, 'Login'>>();
  const { signIn, toast } = useSession();
  const [phone, setPhone] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => { if (cooldown <= 0) return; const timer = setTimeout(() => setCooldown(cooldown - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);

  const send = async () => {
    setError('');
    const normalized = normalizeIndianMobile(phone);
    if (!normalized) { setError('Enter a valid 10-digit mobile number'); return; }
    setBusy(true);
    try { const result = await api.requestOtp(normalized); setSentTo(normalized); setCode(''); setCooldown(result.resendAfterSeconds ?? 60); }
    catch (err) { setError(errorMessage(err, 'Could not send the code')); } finally { setBusy(false); }
  };
  const complete = async (token: string | undefined) => {
    if (!token) throw new Error('No session token returned');
    await signIn(token);
    toast('Signed in successfully', 'success');
    // Signed in from "Checkout": continue straight to it (the guest cart has been merged).
    if (route.params?.next === 'Checkout') navigation.dispatch(StackActions.replace('Checkout'));
    else navigation.goBack();
  };
  const verify = async () => {
    if (!sentTo || !/^\d{6}$/.test(code)) { setError('Enter the 6-digit code'); return; }
    setBusy(true); setError('');
    try { const result = await api.verifyOtp(sentTo, code); await complete(result.accessToken); }
    catch (err) { setError(errorMessage(err, 'The code is invalid or expired')); } finally { setBusy(false); }
  };
  const google = async (idToken: string) => {
    try { const result = await api.googleSignIn(idToken); await complete(result.accessToken); } catch (err) { setError(errorMessage(err, 'Google sign-in failed')); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <ScreenHeader title="Sign In" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} keyboardShouldPersistTaps="handled">
          <Image source={require('../../assets/logo-full.png')} style={{ width: 240, height: 56, alignSelf: 'center', marginVertical: 12 }} resizeMode="contain" />
          <Title size={22} style={{ textAlign: 'center' }}>{sentTo ? 'Verify your number' : 'Sign in or create account'}</Title>
          <Body muted style={{ textAlign: 'center' }}>{sentTo ? `Enter the 6-digit code sent to ${formatPhone(sentTo)}` : 'We will send a one-time code to your mobile number.'}</Body>
          {!sentTo ? (
            <>
              <View style={s.phone}><Text style={s.prefix}>+91</Text><TextInput style={s.phoneInput} keyboardType="phone-pad" maxLength={10} value={phone} onChangeText={value => setPhone(value.replace(/\D/g, ''))} placeholder="98765 43210" placeholderTextColor={colors.muted2} autoFocus accessibilityLabel="Mobile number" /></View>
              {error ? <Body size={13} style={{ color: colors.red }}>{error}</Body> : null}
              <Button title="Send OTP" loading={busy} onPress={() => void send()} />
              {GOOGLE_ANDROID_CLIENT_ID ? (<><Body muted style={{ textAlign: 'center' }}>or</Body><GoogleSignIn onToken={token => void google(token)} /></>) : null}
            </>
          ) : (
            <>
              <TextInput style={s.otp} keyboardType="number-pad" maxLength={6} value={code} onChangeText={value => setCode(value.replace(/\D/g, ''))} autoFocus textContentType="oneTimeCode" autoComplete="sms-otp" accessibilityLabel="One-time code" />
              {error ? <Body size={13} style={{ color: colors.red }}>{error}</Body> : null}
              <Button title="Verify & Continue" loading={busy} disabled={code.length !== 6} onPress={() => void verify()} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Pressable onPress={() => { setSentTo(null); setError(''); }}><Text style={s.link}>Change number</Text></Pressable>
                <Pressable disabled={cooldown > 0 || busy} onPress={() => void send()}><Text style={[s.link, cooldown > 0 && { opacity: 0.5 }]}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}</Text></Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function LockScreen() {
  const { unlock, signOut } = useSession();
  useEffect(() => { void unlock(); }, [unlock]);
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory, justifyContent: 'center', padding: 24, gap: 16 }}>
      <Image source={require('../../assets/logo-full.png')} style={{ width: 240, height: 56, alignSelf: 'center' }} resizeMode="contain" />
      <Title size={22} style={{ textAlign: 'center' }}>Unlock to continue</Title>
      <Body muted style={{ textAlign: 'center' }}>Use your fingerprint to open your account.</Body>
      <Button title="Unlock" onPress={() => void unlock()} />
      <Button variant="ghost" title="Sign out" onPress={() => void signOut()} />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  phone: { flexDirection: 'row', borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, backgroundColor: colors.white, overflow: 'hidden', height: 52 },
  prefix: { paddingHorizontal: 14, textAlignVertical: 'center', lineHeight: 52, fontFamily: fonts.semibold, fontSize: 16, backgroundColor: colors.cream, color: colors.ink },
  phoneInput: { flex: 1, paddingHorizontal: 14, fontFamily: fonts.medium, fontSize: 17, letterSpacing: 1, color: colors.ink },
  otp: { height: 58, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, backgroundColor: colors.white, textAlign: 'center', fontFamily: fonts.bold, fontSize: 26, letterSpacing: 10, color: colors.ink },
  link: { color: colors.red, fontFamily: fonts.semibold, fontSize: 14 },
});
