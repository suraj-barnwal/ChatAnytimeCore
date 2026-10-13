FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ChatAPI.csproj ./
RUN dotnet restore ChatAPI.csproj
COPY . ./
RUN dotnet publish ChatAPI.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app/publish ./
ENTRYPOINT ["dotnet", "ChatAPI.dll"]
