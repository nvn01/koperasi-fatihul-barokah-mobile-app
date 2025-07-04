import React, { useState, useEffect } from "react";
import {
	View,
	Text,
	StyleSheet,
	TouchableOpacity,
	Alert,
	ActivityIndicator,
	useWindowDimensions,
	Platform,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { storage } from "../../lib/storage";
import { DatabaseService } from "../../lib/database.service";
import { useAuth } from "../../context/auth-context";
import { BackHeader } from "../../components/header/back-header";

interface PinKeypadProps {
	onKeyPress: (key: string) => void;
}

const PinKeypad = ({ onKeyPress }: PinKeypadProps) => {
	const { width } = useWindowDimensions();
	const keys = [
		"1",
		"2",
		"3",
		"4",
		"5",
		"6",
		"7",
		"8",
		"9",
		"",
		"0",
		"del",
	];

	// Calculate responsive button size based on screen width
	const buttonSize = Math.min(width * 0.22, 70); // Slightly smaller buttons (22% of width)
	const buttonMargin = 10; // Fixed margin to match design

	return (
		<View style={styles.keypadContainer}>
			{keys.map((key, index) => (
				<TouchableOpacity
					key={index}
					style={[
						styles.keyButton,
						key === "" && styles.emptyButton,
						{
							width: buttonSize,
							height: buttonSize,
							margin: buttonMargin,
						},
					]}
					onPress={() => key && onKeyPress(key)}
					disabled={key === ""}
				>
					{key === "del" ? (
						<Text style={styles.deleteButtonText}>
							⌫
						</Text>
					) : (
						<Text style={styles.keyButtonText}>
							{key}
						</Text>
					)}
				</TouchableOpacity>
			))}
		</View>
	);
};

export default function SecuritySetupScreen() {
	const [pin, setPin] = useState<string>("");
	const [confirmPin, setConfirmPin] = useState<string>("");
	const [step, setStep] = useState<"create" | "confirm">("create");
	const [isLoading, setIsLoading] = useState<boolean>(false);
	const [accountId, setAccountId] = useState<string>("");
	const [errorMessage, setErrorMessage] = useState<string>("");
	const { login } = useAuth();

	const handleKeyPress = (key: string) => {
		if (step === "create") {
			if (key === "del") {
				setPin((prev) => prev.slice(0, -1));
			} else if (pin.length < 6) {
				const newPin = pin + key;
				setPin(newPin);

				// Auto-advance to confirm step when PIN is complete
				if (newPin.length === 6) {
					setTimeout(() => {
						setStep("confirm");
					}, 300);
				}
			}
		} else {
			if (key === "del") {
				setConfirmPin((prev) => prev.slice(0, -1));
			} else if (confirmPin.length < 6) {
				const newConfirmPin = confirmPin + key;
				setConfirmPin(newConfirmPin);

				// Auto-verify when confirm PIN is complete
				if (newConfirmPin.length === 6) {
					setTimeout(() => {
						// Verify PIN match
						if (pin === newConfirmPin) {
							// Save PIN to database
							savePinToDatabase(pin);
						} else {
							setErrorMessage(
								"PIN yang Anda masukkan tidak cocok. Silakan coba lagi."
							);
							// Reset inputs
							setPin("");
							setConfirmPin("");
							setStep("create");
						}
					}, 300);
				}
			}
		}
	};

	// Load account ID from secure storage
	useEffect(() => {
		const loadAccountId = async () => {
			try {
				const storedAccountId = await storage.getItem(
					"temp_account_id"
				);
				if (storedAccountId) {
					setAccountId(storedAccountId);
				} else {
					// If no account ID is found, go back to account validation
					setErrorMessage(
						"Data akun tidak ditemukan. Silakan coba lagi."
					);
					router.replace("/onboarding/account-validation");
				}
			} catch (error) {
				console.log("Error loading account ID:", error);
				setErrorMessage(
					"Terjadi kesalahan. Silakan coba lagi."
				);
			}
		};

		loadAccountId();
	}, []);

	// Clear error message after 5 seconds
	useEffect(() => {
		if (errorMessage) {
			const timer = setTimeout(() => {
				setErrorMessage("");
			}, 5000);

			return () => clearTimeout(timer);
		}
	}, [errorMessage]);

	const savePinToDatabase = async (pinToSave: string) => {
		if (!accountId) {
			setErrorMessage(
				"Data akun tidak ditemukan. Silakan coba lagi."
			);
			return;
		}

		setIsLoading(true);

		try {
			// Save PIN to database
			const success = await DatabaseService.setAccountPin(
				accountId,
				pinToSave
			);

			if (!success) {
				setErrorMessage(
					"Gagal menyimpan PIN. Silakan coba lagi."
				);
				setIsLoading(false);
				return;
			}

			// Clean up temporary storage
			await storage.removeItem("temp_phone_number");
			await storage.removeItem("temp_account_id");

			// Store account ID for authentication
			await storage.setItem("koperasi_auth_account_id", accountId);

			// Log in the user with the new account ID
			const loginSuccess = await login(accountId);

			if (!loginSuccess) {
				console.log("Failed to login after PIN setup");
				setErrorMessage(
					"Gagal masuk ke akun. Silakan coba lagi."
				);
				setIsLoading(false);
				return;
			}

			// Clear the entire navigation stack and navigate to dashboard
			console.log("PIN setup complete, navigating to dashboard");

			// Clear any temporary storage
			await storage.removeItem("temp_phone_number");
			await storage.removeItem("temp_account_id");

			// Use router.replace with reset to clear the entire stack
			router.dismissAll();
			router.replace("/");
		} catch (error) {
			console.log("Error saving PIN:", error);
			setErrorMessage("Terjadi kesalahan. Silakan coba lagi.");
			setIsLoading(false);
		}
	};

	const { height } = useWindowDimensions();

	return (
		<SafeAreaProvider>
			<SafeAreaView style={styles.container} edges={["bottom"]}>
				<BackHeader title="Pengaturan Keamanan" />

				<View style={styles.content}>
					{isLoading ? (
						<View style={styles.loadingContainer}>
							<ActivityIndicator
								size="large"
								color="#007BFF"
							/>
							<Text style={styles.loadingText}>
								Menyimpan PIN Anda...
							</Text>
						</View>
					) : (
						<>
							<Text style={styles.title}>
								{step === "create"
									? "Buat PIN Anda"
									: "Konfirmasi PIN"}
							</Text>
							<Text style={styles.subtitle}>
								{step === "create"
									? "Masukkan 6 digit PIN kamu"
									: "Masukkan kembali PIN kamu untuk konfirmasi"}
							</Text>

							<Text
								style={[
									styles.errorText,
									!errorMessage &&
										styles.errorTextHidden,
								]}
							>
								{errorMessage ||
									"PIN yang Anda masukkan salah. Silakan coba lagi."}
							</Text>

							<View style={styles.headerSection}>
								<View
									style={
										styles.pinContainer
									}
								>
									{Array(6)
										.fill(0)
										.map((_, index) => {
											const currentPin =
												step ===
												"create"
													? pin
													: confirmPin;
											const isFilled =
												index <
												currentPin.length;

											return (
												<View
													key={
														index
													}
													style={[
														styles.pinDot,
														isFilled &&
															styles.pinDotFilled,
													]}
												/>
											);
										})}
								</View>
							</View>

							<View style={styles.keypadSection}>
								<PinKeypad
									onKeyPress={
										handleKeyPress
									}
								/>
							</View>

							<View style={styles.footerSection}>
								<View
									style={
										styles.infoContainer
									}
								>
									<Text
										style={
											styles.infoText
										}
									>
										PIN Anda akan
										digunakan untuk
										mengamankan akun dan
										mengotorisasi
										transaksi.
									</Text>
								</View>
							</View>
						</>
					)}
				</View>
			</SafeAreaView>
		</SafeAreaProvider>
	);
}

const styles = StyleSheet.create({
	container: {
		flex: 1,
		backgroundColor: "#fff",
	},
	loadingContainer: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	loadingText: {
		marginTop: 20,
		fontSize: 16,
		color: "#666",
	},
	content: {
		flex: 1,
		paddingHorizontal: 24,
		justifyContent: "space-between",
	},
	headerSection: {
		alignItems: "center",
		paddingTop: 20,
	},
	keypadSection: {
		alignItems: "center",
		justifyContent: "center",
		flex: 1,
	},
	footerSection: {
		width: "100%",
		paddingBottom: Platform.OS === "ios" ? 10 : 20,
		alignItems: "center",
	},
	title: {
		fontSize: 24,
		fontWeight: "bold",
		marginBottom: 10,
		textAlign: "center",
	},
	subtitle: {
		fontSize: 16,
		color: "#666",
		marginBottom: 10,
		textAlign: "center",
	},
	errorText: {
		fontSize: 14,
		color: "#FF3B30",
		marginBottom: 20,
		textAlign: "center",
		height: 20,
		opacity: 1,
	},
	errorTextHidden: {
		opacity: 0,
	},
	pinContainer: {
		flexDirection: "row",
		justifyContent: "center",
		marginBottom: 40,
	},
	pinDot: {
		width: 16,
		height: 16,
		borderRadius: 8,
		backgroundColor: "#f0f0f0",
		margin: 10,
	},
	pinDotFilled: {
		backgroundColor: "#4CD2C8",
	},
	keypadContainer: {
		flexDirection: "row",
		flexWrap: "wrap",
		justifyContent: "center",
		alignItems: "center",
		width: "100%",
		maxWidth: 340,
		paddingHorizontal: 10,
	},
	keyButton: {
		justifyContent: "center",
		alignItems: "center",
		borderRadius: 50,
		backgroundColor: "#f8f8f8",
		marginVertical: 12,
		marginHorizontal: 12,
	},
	emptyButton: {
		backgroundColor: "transparent",
	},
	keyButtonText: {
		fontSize: 28,
		fontWeight: "bold",
		color: "#333",
	},
	deleteButtonText: {
		fontSize: 28,
		color: "#666",
	},
	infoContainer: {
		backgroundColor: "rgba(0, 123, 255, 0.1)",
		borderRadius: 8,
		padding: 15,
		marginTop: 10,
		marginBottom: 10,
		width: "90%",
		maxWidth: 340,
	},
	infoText: {
		fontSize: 14,
		color: "#007BFF",
		textAlign: "center",
	},
});
