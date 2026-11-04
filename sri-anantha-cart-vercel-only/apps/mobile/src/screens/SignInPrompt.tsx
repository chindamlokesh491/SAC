import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { UserRound } from 'lucide-react-native';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, EmptyState, Title } from '../components/ui';
import type { RootStackParamList } from '../navigation-types';
import { colors } from '../theme';

export function SignInPrompt({ title, message }: { title: string; message: string }) {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ivory }} edges={['top']}>
      <View style={{ alignItems: 'center', paddingVertical: 14 }}><Title size={20}>{title}</Title></View>
      <EmptyState icon={<UserRound size={44} color={colors.saffron} />} title="Sign in to continue" body={message} action={<Button title="Sign in with mobile number" onPress={() => navigation.navigate('Login')} />} />
    </SafeAreaView>
  );
}
